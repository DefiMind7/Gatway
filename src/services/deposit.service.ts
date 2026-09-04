import crypto from 'node:crypto';
import { Prisma, type DepositIntent } from '@prisma/client';
import { PublicKey } from '@solana/web3.js';
import { config, LAMPORTS_PER_SOL, TOTAL_BPS } from '../config';
import { prisma } from '../database/client';
import {
  DepositIntentStatus,
  DepositMethod,
  DEPOSIT_METHODS,
  GatewayError,
  OrderStatus,
  SUPPORTED_CURRENCIES,
  isAutoConfirmable,
  type DepositInstructionView,
  type DepositIntentPublicView,
  type EffectiveFee,
  type FiatCurrency,
  type NormalizedFiatEvent,
} from '../types';
import { logger } from '../utils/logger';
import { resolveInternalFee } from './fee.service';
import {
  createCardPayment,
  createPixPayment,
  createPreference,
  explainRejection,
  supportsEmbeddedCheckout,
  type MpPayment,
} from './mercadopago.service';
import { quoteHuman } from './jupiter.service';
import { LOCK_NAMES, withLockOrThrow } from './lock.service';
import { createOrderFromEvent, dispatchOrderPipeline } from './order.service';
import { getTokenBalanceRaw } from './solana.service';
import { getSettings } from './settings.service';
import { createWallet, revealSecret, type RevealedSecret } from './wallet.service';
import { notifyMerchant } from './merchant.service';

/**
 * PROVEDOR INTERNO DE DEPÓSITOS.
 *
 * Por que existe: um on-ramp de verdade (SpherePay, MoonPay, Transak) só
 * libera webhook depois de onboarding de empresa — semanas. Este módulo é o
 * caminho para receber dinheiro HOJE, com o operador no papel de provedor.
 *
 * Três trilhos, com garantias bem diferentes:
 *
 *  • CARD (automático) — o cliente paga no cartão pelo Mercado Pago. O
 *    dinheiro cai na conta do PSP do operador; a ordem é lastreada pelo float
 *    de USDC do vault. É aqui que a RETENÇÃO EM FIAT se aplica: por padrão
 *    30% do valor pago fica na conta (é a receita) e só os 70% restantes
 *    viram SOL para o cliente.
 *
 *  • USDC (automático) — o cliente manda USDC para o vault. A chegada é
 *    detectada on-chain (`deposit-watch.service.ts`), sem humano no meio. O
 *    dinheiro que lastreia a ordem é o próprio depósito. Sem retenção: quem
 *    entrega stablecoin não tem "parte em fiat" a reter — a receita aí é a
 *    taxa on-chain (`feeBps`), como sempre foi.
 *
 *  • Pix / SEPA / MB Way / Revolut (manual) — o cliente transfere fiat para a
 *    conta do operador e põe a `reference` na descrição. Extrato bancário não
 *    tem webhook, então a confirmação é um clique no painel. **O USDC que
 *    lastreia a ordem sai do float do vault**: o operador adianta a
 *    stablecoin e fica com o fiat. Sem float, a ordem fica PENDING até haver
 *    saldo — é isso que `DEPOSIT_NOT_COVERED` significa.
 *
 * A confirmação, nos dois casos, produz o MESMO `NormalizedFiatEvent` que um
 * provedor externo produziria. Nada a jusante (swap, liquidação, lucro,
 * distribuição) sabe que o provedor é interno — quando um on-ramp real for
 * aprovado, o webhook dele entra por `/webhook/fiat-payment` e este módulo
 * continua valendo para os trilhos manuais.
 */

const log = logger.child({ scope: 'deposit' });

/** Alfabeto sem 0/O/1/I/L: a referência é ditada por telefone e digitada à mão. */
const REFERENCE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function newReference(): string {
  const bytes = crypto.randomBytes(6);
  let out = '';
  for (const byte of bytes) out += REFERENCE_ALPHABET[byte % REFERENCE_ALPHABET.length];
  return `GW-${out}`;
}

// ─────────────────────────── Câmbio do operador ───────────────────────────

export type DepositRates = Record<string, number>;

/**
 * Quantos USDC valem 1 unidade de cada moeda, segundo o OPERADOR.
 *
 * Não é cotação de mercado de propósito: num trilho manual o câmbio real é o
 * que o operador consegue no banco dele. Vem do painel (`depositRatesJson`).
 */
export async function getDepositRates(): Promise<DepositRates> {
  const settings = await getSettings();
  const fallback: DepositRates = { USD: 1, EUR: 1, BRL: 1 };

  let parsed: unknown;
  try {
    parsed = JSON.parse(settings.depositRatesJson);
  } catch {
    log.error({ raw: settings.depositRatesJson }, 'depositRatesJson inválido — usando 1:1');
    return fallback;
  }
  if (parsed === null || typeof parsed !== 'object') return fallback;

  const rates: DepositRates = { ...fallback };
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const rate = Number(value);
    if (Number.isFinite(rate) && rate > 0) rates[key.toUpperCase()] = rate;
  }
  return rates;
}

// ─────────────────────────── Retenção em fiat ───────────────────────────

/**
 * Trilhos em que o operador recebe FIAT e portanto pode reter uma parte dele.
 * USDC fica de fora: não existe "30% numa conta bancária" quando o que entrou
 * foi stablecoin.
 */
function isFiatRail(method: DepositMethod): boolean {
  return method !== DepositMethod.USDC;
}

/**
 * Taxa on-chain ZERO.
 *
 * Usada nas ordens com retenção em fiat: a receita já foi tirada antes da
 * conversão, então o cliente recebe 100% do SOL que os 70% dele compraram.
 * Cobrar `feeBps` por cima seria cobrar duas vezes pela mesma operação.
 */
const NO_ONCHAIN_FEE: EffectiveFee = {
  providerCostBps: 0,
  marginBps: 0,
  feeBps: 0,
  sourceProvider: 'internal',
  clamped: false,
};

export interface AmountSplit {
  retainedBps: number;
  /** Fica em fiat na conta do operador. */
  retainedFiat: number;
  /** Vira cripto para o cliente. */
  convertedFiat: number;
}

/** Divide o valor pago entre a parte retida e a parte convertida. */
export function splitAmount(amount: number, retainedBps: number): AmountSplit {
  const retainedFiat = Number(((amount * retainedBps) / TOTAL_BPS).toFixed(2));
  return {
    retainedBps,
    retainedFiat,
    // O convertido é o resto por subtração, nunca um segundo arredondamento:
    // retido + convertido tem de dar exatamente o que o cliente pagou.
    convertedFiat: Number((amount - retainedFiat).toFixed(2)),
  };
}

// ─────────────────────────── Instruções por trilho ───────────────────────────

const DEFAULT_LABELS: Record<DepositMethod, string> = {
  USDC: 'USDC na Solana',
  CARD: 'Cartão de crédito ou débito',
  PIXQR: 'Pix (QR na hora)',
  PIX: 'Pix',
  SEPA: 'Transferência SEPA',
  MBWAY: 'MB Way',
  REVOLUT: 'Revolut',
};

/**
 * Como pagar por um trilho. Para USDC o destino é o próprio vault — não há
 * nada a configurar, e é por isso que este é o trilho que sobe em minutos.
 */
export function instructionsFor(method: DepositMethod, reference: string): DepositInstructionView {
  const configured = config.deposit.instructions[method] ?? {};
  const payTo =
    method === DepositMethod.USDC
      ? config.solana.vaultPublicKey.toBase58()
      : (configured.payTo ?? '');

  if (method === DepositMethod.PIXQR) {
    return {
      method,
      label: configured.label ?? DEFAULT_LABELS[method],
      // O "destino" é o próprio QR, que muda a cada cobrança.
      payTo: '',
      lines: configured.lines ?? [
        'Abra o app do seu banco, escolha Pix e leia o QR (ou cole o código).',
        'O valor já vai no código — não precisa digitar nada.',
        'A confirmação é automática, poucos segundos depois do pagamento.',
      ],
      autoConfirm: true,
    };
  }

  if (method === DepositMethod.CARD) {
    return {
      method,
      label: configured.label ?? DEFAULT_LABELS[method],
      // O "destino" do cartão é a página do PSP, não uma chave a copiar.
      payTo: '',
      ...(configured.holder !== undefined ? { holder: configured.holder } : {}),
      lines: configured.lines ?? [
        'Você será levado ao checkout do Mercado Pago para pagar com cartão.',
        'Depois de aprovado, volte para esta página — ela confirma sozinha.',
        'O cartão é processado pelo Mercado Pago; este site não vê os dados dele.',
      ],
      autoConfirm: true,
      redirect: true,
    };
  }

  const defaultLines =
    method === DepositMethod.USDC
      ? [
          `Envie EXATAMENTE o valor indicado, em USDC (mint ${config.swap.inputMint}), na rede Solana.`,
          'O valor exato é o que identifica o seu depósito — enviar outro valor atrasa a confirmação.',
          'A confirmação é automática, normalmente menos de um minuto depois de a rede confirmar.',
        ]
      : [
          `Coloque "${reference}" na descrição/mensagem da transferência.`,
          'Sem a referência na descrição, a confirmação depende de conferência manual do extrato.',
          'A confirmação é feita pelo operador depois de o dinheiro cair na conta.',
        ];

  return {
    method,
    label: configured.label ?? DEFAULT_LABELS[method],
    payTo,
    ...(configured.holder !== undefined ? { holder: configured.holder } : {}),
    lines: configured.lines ?? defaultLines,
    autoConfirm: isAutoConfirmable(method) && config.deposit.autoConfirm,
  };
}

/**
 * O que o checkout público mostra: trilhos, limites e a chave pública do PSP.
 *
 * Não devolve margem, câmbio do operador nem retenção. Esses números são a
 * precificação do negócio; mandá-los ao navegador seria publicá-los, e é o
 * tipo de coisa que não se despublica depois.
 */
export async function getCheckoutOptions(): Promise<{
  enabled: boolean;
  methods: Array<{
    method: DepositMethod;
    label: string;
    autoConfirm: boolean;
    /** USDC é cotado em USD; os trilhos fiat, em qualquer moeda suportada. */
    currencies: FiatCurrency[];

  }>;
  minAmount: number;
  maxAmount: number;
  ttlMinutes: number;

  /**
   * Dados do checkout de cartão embutido. A `publicKey` é pública por
   * definição — é ela que o SDK do MP usa no navegador para tokenizar.
   */
  card: { embedded: boolean; publicKey: string };
}> {

  return {
    enabled: config.deposit.enabled,
    methods: config.deposit.methods.map((method) => ({
      method,
      label: instructionsFor(method, 'GW-XXXXXX').label,
      autoConfirm: isAutoConfirmable(method) && config.deposit.autoConfirm,
      // Pix só existe em real; USDC é cotado em dólar. Oferecer outra moeda
      // nesses trilhos seria cobrar num câmbio que o meio de pagamento não
      // conhece.
      /**
       * Cada trilho só oferece a moeda que consegue processar. O cartão é
       * limitado pelo país da conta do PSP: uma conta brasileira cobra em BRL
       * e recusa qualquer outra — inclusive o BIN de um cartão estrangeiro.
       */
      currencies:
        method === DepositMethod.USDC
          ? ['USD' as FiatCurrency]
          : method === DepositMethod.PIXQR
            ? ['BRL' as FiatCurrency]
            : method === DepositMethod.CARD
              ? [config.mercadopago.currency as FiatCurrency]
              : method === DepositMethod.PIX
                ? ['BRL' as FiatCurrency]
                : [...SUPPORTED_CURRENCIES],

    })),
    minAmount: config.deposit.minAmount,
    maxAmount: config.deposit.maxAmount,
    ttlMinutes: Math.round(config.deposit.ttlMs / 60_000),
    card: {
      embedded: supportsEmbeddedCheckout(),
      publicKey: config.mercadopago.publicKey,
    },
  };
}

// ─────────────────────────── Float do vault ───────────────────────────

export interface FloatStatus {
  /** USDC no vault, em base units. */
  balanceRaw: bigint;
  /** Já prometido a ordens em andamento e a intenções em aberto. */
  committedRaw: bigint;
  /** O que sobra para uma nova ordem. */
  availableRaw: bigint;
}

/**
 * Quanto do float ainda não está prometido.
 *
 * Conta duas coisas, e as duas importam:
 *  • ordens que ainda não swaparam — o USDC delas está reservado;
 *  • intenções fiat em aberto — o cliente pode pagar a qualquer momento, e
 *    aceitar um segundo depósito contra o mesmo saldo é prometer duas vezes o
 *    mesmo dinheiro.
 *
 * Intenções em USDC ficam de fora: elas trazem o próprio lastro.
 */
export async function getFloatStatus(): Promise<FloatStatus> {
  const [balanceRaw, orders, intents] = await Promise.all([
    getTokenBalanceRaw(config.swap.inputMint).catch(() => 0n),
    prisma.order.findMany({
      where: {
        inputMint: config.swap.inputMint,
        swapSignature: null,
        status: { in: [OrderStatus.PENDING, OrderStatus.PROCESSING] },
      },
      select: { inputAmountRaw: true },
    }),
    prisma.depositIntent.findMany({
      where: {
        status: DepositIntentStatus.AWAITING_PAYMENT,
        method: { not: DepositMethod.USDC },
        expiresAt: { gt: new Date() },
      },
      select: { expectedInputRaw: true },
    }),
  ]);

  const committedRaw =
    orders.reduce((acc, o) => acc + o.inputAmountRaw, 0n) +
    intents.reduce((acc, i) => acc + i.expectedInputRaw, 0n);

  return {
    balanceRaw,
    committedRaw,
    availableRaw: balanceRaw > committedRaw ? balanceRaw - committedRaw : 0n,
  };
}

/**
 * Recusa o depósito quando o vault não tem lastro para entregá-lo.
 *
 * Sem esta trava, o pior cenário do produto acontece calado: o cliente paga no
 * cartão, o dinheiro entra na conta do operador, e a ordem fica presa em
 * `DEPOSIT_NOT_COVERED` esperando um USDC que não existe. Dizer "indisponível"
 * antes de cobrar é infinitamente melhor do que devolver dinheiro depois.
 *
 * Vale só para trilhos fiat — em USDC o lastro é o próprio depósito.
 */
async function assertFloatCovers(method: DepositMethod, requiredRaw: bigint): Promise<void> {
  if (!config.deposit.requireFloat) return;
  if (method === DepositMethod.USDC) return;

  const float = await getFloatStatus();
  if (float.availableRaw >= requiredRaw) return;

  const decimals = config.swap.inputMintDecimals;
  log.error(
    {
      requiredRaw: requiredRaw.toString(),
      availableRaw: float.availableRaw.toString(),
      balanceRaw: float.balanceRaw.toString(),
      committedRaw: float.committedRaw.toString(),
    },
    'depósito recusado por falta de float no vault',
  );

  throw new GatewayError(
    'depósitos estão temporariamente indisponíveis para este valor — tente um valor menor ' +
      'ou volte mais tarde',
    'INSUFFICIENT_FLOAT',
    false,
    {
      requiredUsdc: formatBaseUnits(requiredRaw, decimals),
      availableUsdc: formatBaseUnits(float.availableRaw, decimals),
    },
  );
}

// ─────────────────────────── Criação ───────────────────────────

export interface CreateIntentInput {
  method: string;
  currency: string;
  /** Valor na moeda escolhida (para USDC, o próprio valor em USDC). */
  amount: number;
  /**
   * Carteira do cliente. **Opcional**: vazio significa "não tenho carteira" e
   * o gateway gera uma — é o que tira do caminho a maior fricção do checkout
   * para quem nunca usou cripto.
   */
  customerWallet?: string | undefined;
  /**
   * Conta logada. Quando presente, o destino é a carteira DELA — nascida no
   * cadastro — e nenhuma carteira nova é criada. É o que faz as compras de um
   * mesmo cliente se acumularem num endereço só.
   */
  customer?: { id: string; walletId: string; walletAddress: string } | undefined;
  /** E-mail do pagador. Obrigatório no Pix: o MP recusa a cobrança sem ele. */
  customerEmail?: string | undefined;
  /** CPF do pagador. Algumas contas do MP exigem no Pix. */
  payerDocNumber?: string | undefined;
  clientIp?: string | undefined;
}

export interface CreatedIntent {
  intent: DepositIntent;
  /**
   * Token de posse, devolvido UMA vez, só na criação. O navegador guarda e
   * apresenta para pedir a chave privada da carteira gerada. Não fica no
   * banco em claro — lá vai só o hash.
   */
  claimToken: string | null;
}

function parseMethod(raw: string): DepositMethod {
  const value = String(raw ?? '').toUpperCase() as DepositMethod;
  if (!DEPOSIT_METHODS.includes(value)) {
    throw new GatewayError(`trilho desconhecido: "${raw}"`, 'UNKNOWN_METHOD', false);
  }
  if (!config.deposit.methods.includes(value)) {
    throw new GatewayError(
      `trilho "${value}" não está habilitado (ativos: ${config.deposit.methods.join(', ')})`,
      'METHOD_DISABLED',
      false,
    );
  }
  return value;
}

/**
 * Freio de abuso no endpoint público, contado no BANCO.
 *
 * Um Map em memória não freia nada quando há N instâncias serverless — e é
 * justamente aí que o endpoint fica exposto.
 */
async function assertRateLimit(clientIp: string | undefined): Promise<void> {
  if (clientIp === undefined || clientIp === '') return;

  const since = new Date(Date.now() - 3_600_000);
  const count = await prisma.depositIntent.count({
    where: { clientIp, createdAt: { gte: since } },
  });

  if (count >= config.deposit.maxIntentsPerHour) {
    throw new GatewayError(
      `limite de ${config.deposit.maxIntentsPerHour} depósitos por hora atingido`,
      'RATE_LIMITED',
      false,
    );
  }
}

export async function createIntent(input: CreateIntentInput): Promise<CreatedIntent> {
  if (!config.deposit.enabled) {
    throw new GatewayError('depósitos desabilitados', 'DEPOSITS_DISABLED', false);
  }

  const method = parseMethod(input.method);

  const currency = String(input.currency ?? 'USD').toUpperCase() as FiatCurrency;
  if (!SUPPORTED_CURRENCIES.includes(currency)) {
    throw new GatewayError(
      `moeda não suportada: "${input.currency}" (aceitas: ${SUPPORTED_CURRENCIES.join(', ')})`,
      'UNSUPPORTED_CURRENCY',
      false,
    );
  }
  // USDC é a própria stablecoin: cotá-la em EUR/BRL criaria uma conversão
  // fictícia entre o que o cliente manda e o que a ordem consome.
  if (method === DepositMethod.USDC && currency !== 'USD') {
    throw new GatewayError(
      'depósito em USDC é denominado em USD (1 USDC = 1 USD)',
      'INVALID_CURRENCY_FOR_METHOD',
      false,
    );
  }
  if (method === DepositMethod.PIXQR && currency !== 'BRL') {
    throw new GatewayError(
      'Pix é cobrado em reais (BRL)',
      'INVALID_CURRENCY_FOR_METHOD',
      false,
    );
  }
  if (method === DepositMethod.PIX && currency !== 'BRL') {
    throw new GatewayError('Pix é cobrado em reais (BRL)', 'INVALID_CURRENCY_FOR_METHOD', false);
  }
  if (method === DepositMethod.CARD && currency !== config.mercadopago.currency) {
    throw new GatewayError(
      `esta conta do Mercado Pago (${config.mercadopago.site}) só cobra cartão em ` +
        `${config.mercadopago.currency}`,
      'INVALID_CURRENCY_FOR_METHOD',
      false,
    );
  }

  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new GatewayError('amount precisa ser um número positivo', 'INVALID_AMOUNT', false);
  }
  // Mais de 2 decimais não existe em nenhum dos trilhos e quebraria a
  // comparação exata do valor no matching on-chain.
  if (Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-9) {
    throw new GatewayError('amount aceita no máximo 2 decimais', 'INVALID_AMOUNT', false);
  }
  if (amount < config.deposit.minAmount || amount > config.deposit.maxAmount) {
    throw new GatewayError(
      `amount fora da faixa aceita (${config.deposit.minAmount}..${config.deposit.maxAmount})`,
      'AMOUNT_OUT_OF_RANGE',
      false,
    );
  }

  // A conta manda: com cliente logado, a carteira já existe e é dele.
  const provided =
    input.customer !== undefined
      ? input.customer.walletAddress
      : String(input.customerWallet ?? '').trim();

  if (input.customer === undefined && provided !== '') {
    try {
      new PublicKey(provided);
    } catch {
      throw new GatewayError(
        `carteira Solana inválida: "${provided}"`,
        'INVALID_CUSTOMER_WALLET',
        false,
      );
    }
    if (provided === config.solana.vaultPublicKey.toBase58()) {
      throw new GatewayError(
        'a carteira de destino é o vault do gateway — use a sua própria carteira',
        'CUSTOMER_IS_VAULT',
        false,
      );
    }
  } else if (input.customer === undefined && !config.wallet.enabled) {
    throw new GatewayError(
      'informe a sua carteira Solana (geração automática está desabilitada)',
      'MISSING_CUSTOMER_WALLET',
      false,
    );
  }

  await assertRateLimit(input.clientIp);

  // Retenção em fiat: a parte que NÃO é convertida. Só faz sentido onde o que
  // entra é dinheiro na conta do operador.
  const settings = await getSettings();
  const retainedBps = isFiatRail(method) ? settings.fiatRetainedBps : 0;
  const split = splitAmount(amount, retainedBps);

  // Quanto USDC esta ordem vai consumir. Para USDC é o próprio depósito; para
  // trilho fiat é o câmbio do operador aplicado ao valor JÁ LÍQUIDO da
  // retenção — converter o bruto entregaria ao cliente dinheiro que ficou na
  // conta.
  const rates = await getDepositRates();
  const rate = method === DepositMethod.USDC ? 1 : (rates[currency] ?? 1);
  const expectedInputRaw = BigInt(
    Math.round(split.convertedFiat * rate * 10 ** config.swap.inputMintDecimals),
  );

  if (expectedInputRaw <= 0n) {
    throw new GatewayError(
      'valor convertido resultou em zero — verifique o câmbio configurado',
      'INVALID_AMOUNT',
      false,
    );
  }
  if (expectedInputRaw > config.runtime.maxOrderInputRaw) {
    throw new GatewayError(
      'valor excede o teto por ordem (MAX_ORDER_INPUT_RAW)',
      'ORDER_ABOVE_LIMIT',
      false,
    );
  }

  // Antes de mostrar qualquer instrução de pagamento: temos como entregar?
  await assertFloatCovers(method, expectedInputRaw);

  // Cotação mostrada ao cliente: estimativa, gravada para auditoria do "eu vi X".
  const fee = retainedBps > 0 ? NO_ONCHAIN_FEE : await resolveInternalFee();
  const customerShare = (TOTAL_BPS - fee.feeBps) / TOTAL_BPS;
  let quotedCustomerSol: string | null = null;
  try {
    const jup = await quoteHuman(expectedInputRaw);
    // A estimativa tem de bater com o que ele vai receber: já sem o custo de
    // rede, que é descontado dele na liquidação.
    const net =
      jup.outSol * customerShare - Number(config.runtime.networkCostLamports) / LAMPORTS_PER_SOL;
    quotedCustomerSol = (net > 0 ? net : 0).toFixed(9);
  } catch (err) {
    // Jupiter fora do ar não impede receber dinheiro: o valor final é sempre o
    // delta real do swap, não esta estimativa.
    log.warn({ err }, 'estimativa de SOL indisponível — intenção segue sem cotação');
  }

  /**
   * A carteira é criada só aqui, depois de tudo validado: gerar antes deixaria
   * carteira órfã no banco a cada formulário preenchido errado.
   */
  const generated =
    input.customer === undefined && provided === '' ? await createWallet(input.clientIp) : null;
  const wallet = generated?.publicKey ?? provided;

  /**
   * Token de posse: só existe no depósito AVULSO, onde não há conta para
   * autenticar quem pede a chave. Com cadastro, a chave sai pela sessão — que
   * é revogável e não vive na URL.
   */
  const claimToken = generated === null ? null : crypto.randomBytes(32).toString('base64url');
  const claimTokenHash =
    claimToken === null ? null : crypto.createHash('sha256').update(claimToken).digest('hex');

  /**
   * O Mercado Pago exige e-mail do pagador no Pix. Com conta, é o da conta —
   * sem conta, o cliente informa. Não inventamos um: e-mail falso faz o MP
   * recusar a cobrança, e o cliente ficaria sem entender por quê.
   */
  const payerEmail = input.customerEmail ?? '';
  if (method === DepositMethod.PIXQR && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(payerEmail)) {
    throw new GatewayError(
      'informe um e-mail válido para gerar o Pix',
      'MISSING_PAYER_EMAIL',
      false,
    );
  }

  const expiresAt = new Date(Date.now() + config.deposit.ttlMs);

  // Colisão de referência é improvável (31^6) mas não impossível; o UNIQUE
  // decide e nós tentamos de novo.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const intent = await prisma.depositIntent.create({
        data: {
          reference: newReference(),
          method,
          fiatCurrency: currency,
          fiatAmount: new Prisma.Decimal(amount.toFixed(2)),
          customerWallet: wallet,
          expectedInputRaw,
          quotedFeeBps: fee.feeBps,
          quotedCustomerSol,
          fiatRetainedBps: retainedBps,
          retainedFiatAmount: new Prisma.Decimal(split.retainedFiat.toFixed(2)),
          ...(generated !== null ? { walletId: generated.id } : {}),
          ...(input.customer !== undefined
            ? { customerId: input.customer.id, walletId: input.customer.walletId }
            : {}),
          ...(claimTokenHash !== null ? { claimTokenHash } : {}),
          status: DepositIntentStatus.AWAITING_PAYMENT,
          expiresAt,
          ...(input.clientIp !== undefined ? { clientIp: input.clientIp } : {}),
        },
      });

      /**
       * Pix: a cobrança nasce junto da intenção, porque é dela que sai o QR
       * que a página mostra. `external_reference` é o fio que liga o pagamento
       * de volta aqui.
       */
      if (method === DepositMethod.PIXQR) {
        /**
         * `/v1/payments` (QR direto) exige credencial de PRODUÇÃO da conta
         * real — credencial de usuário de teste é recusada com
         * "Unauthorized use of live credentials". Quando isso acontece, cair
         * para o Checkout Pro é melhor do que devolver erro: o cliente ainda
         * paga por Pix, só que na página do Mercado Pago.
         */
        const charge = await createPixPayment({
          reference: intent.reference,
          amount,
          description: `Deposito ${intent.reference}`,
          payerEmail: payerEmail,
          ...(input.payerDocNumber !== undefined
            ? { payerDocNumber: input.payerDocNumber }
            : {}),
          expiresInMinutes: Math.round(config.deposit.ttlMs / 60_000),
        }).catch((err: unknown) => {
          log.warn(
            { reference: intent.reference, err },
            'QR do Pix indisponível — caindo para o checkout do Mercado Pago',
          );
          return null;
        });

        if (charge === null) {
          const preference = await createPreference({
            reference: intent.reference,
            title: `Depósito ${intent.reference}`,
            amount,
            currency,
          });
          return {
            intent: await prisma.depositIntent.update({
              where: { id: intent.id },
              data: {
                pspPreferenceId: preference.preferenceId,
                pspCheckoutUrl: preference.checkoutUrl,
              },
            }),
            claimToken,
          };
        }

        const withPix = await prisma.depositIntent.update({
          where: { id: intent.id },
          data: {
            pspPaymentId: charge.payment.id,
            pixCopyPaste: charge.copyPaste,
            pixQrBase64: charge.qrBase64,
            pixExpiresAt: charge.expiresAt,
          },
        });

        log.info(
          {
            reference: intent.reference,
            paymentId: charge.payment.id,
            retainedFiat: split.retainedFiat,
          },
          'intenção de Pix criada com QR',
        );
        return { intent: withPix, claimToken };
      }

      /**
       * O checkout do PSP é criado DEPOIS da intenção, e de propósito: a
       * preferência precisa da referência como `external_reference`, que é o
       * único fio que liga o pagamento de volta a esta intenção.
       *
       * Se o MP falhar aqui, a intenção fica gravada sem link — o cliente vê
       * o erro e tenta de novo, e nada de dinheiro se perdeu.
       */
      /**
       * A preferência é criada SEMPRE para cartão, mesmo com o checkout
       * embutido ligado.
       *
       * Custa uma chamada e compra um plano B real: se a cobrança direta for
       * recusada por pareamento de credencial (o MP responde "Unauthorized use
       * of live credentials" quando token e access token não são do mesmo
       * conjunto), o cliente ainda tem o link do Checkout Pro na mesma tela em
       * vez de uma página morta.
       */
      if (method === DepositMethod.CARD) {
        // Falha aqui não pode derrubar a intenção: com o Brick disponível, o
        // link é só a alternativa.
        const preference = await createPreference({
          reference: intent.reference,
          title: `Depósito ${intent.reference}`,
          amount,
          currency,
        }).catch((err: unknown) => {
          log.warn({ reference: intent.reference, err }, 'não foi possível criar o link do PSP');
          return null;
        });

        if (preference === null) {
          if (!supportsEmbeddedCheckout()) throw new GatewayError(
            'não foi possível abrir o checkout do Mercado Pago',
            'PSP_ERROR',
            true,
          );
          return { intent, claimToken };
        }

        const withCheckout = await prisma.depositIntent.update({
          where: { id: intent.id },
          data: {
            pspPreferenceId: preference.preferenceId,
            pspCheckoutUrl: preference.checkoutUrl,
          },
        });
        log.info(
          {
            reference: intent.reference,
            retainedFiat: split.retainedFiat,
            convertedFiat: split.convertedFiat,
            sandbox: preference.sandbox,
          },
          'intenção de cartão criada com checkout do PSP',
        );
        return { intent: withCheckout, claimToken };
      }

      log.info(
        {
          reference: intent.reference,
          method,
          fiat: `${amount.toFixed(2)} ${currency}`,
          retainedFiat: split.retainedFiat,
          expectedInputRaw: expectedInputRaw.toString(),
          wallet,
          walletGenerated: generated !== null,
          feeBps: fee.feeBps,
        },
        'intenção de depósito criada',
      );
      return { intent, claimToken };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
      throw err;
    }
  }

  throw new GatewayError(
    'não foi possível gerar uma referência única — tente novamente',
    'REFERENCE_COLLISION',
    true,
  );
}

// ─────────────────────────── Confirmação ───────────────────────────

export interface ConfirmOptions {
  /** "admin" ou "onchain-watch". Fica gravado na intenção. */
  confirmedBy: string;
  note?: string | undefined;
  /** Assinatura da tx do cliente (trilho USDC). UNIQUE no banco. */
  depositSignature?: string | undefined;
  /** Confirma uma intenção já expirada — pagamento que chegou atrasado. */
  force?: boolean;
}

export interface ConfirmResult {
  intent: DepositIntent;
  orderId: string;
  /** false quando a intenção já estava confirmada (idempotência). */
  created: boolean;
  pipeline: { inline: boolean; timedOut: boolean; elapsedMs: number } | null;
}

/**
 * Reconhece o pagamento e entrega a ordem à pipeline.
 *
 * Idempotente em duas camadas: o lock impede duas confirmações simultâneas da
 * mesma intenção, e `providerEventId = manual_<id>` é UNIQUE em `Order` — uma
 * intenção nunca gera duas ordens, nem que o admin clique dez vezes.
 */
export async function confirmIntent(
  reference: string,
  options: ConfirmOptions,
): Promise<ConfirmResult> {
  const ref = String(reference ?? '').trim().toUpperCase();
  const found = await prisma.depositIntent.findUnique({ where: { reference: ref } });
  if (!found) {
    throw new GatewayError(`intenção não encontrada: "${ref}"`, 'INTENT_NOT_FOUND', false);
  }

  return withLockOrThrow(
    LOCK_NAMES.depositIntent(found.id),
    async () => {
      // Releitura sob o lock: o estado pode ter mudado entre a busca e o lock.
      const intent = await prisma.depositIntent.findUnique({ where: { id: found.id } });
      if (!intent) {
        throw new GatewayError('intenção desapareceu', 'INTENT_NOT_FOUND', false);
      }

      if (intent.status === DepositIntentStatus.CONFIRMED && intent.orderId !== null) {
        log.info(
          { reference: intent.reference, orderId: intent.orderId },
          'intenção já confirmada — ignorando (idempotência)',
        );
        return { intent, orderId: intent.orderId, created: false, pipeline: null };
      }
      if (intent.status === DepositIntentStatus.CANCELLED) {
        throw new GatewayError(
          'intenção cancelada — crie uma nova em vez de confirmar esta',
          'INTENT_CANCELLED',
          false,
        );
      }
      if (intent.status === DepositIntentStatus.EXPIRED || intent.expiresAt.getTime() < Date.now()) {
        if (options.force !== true) {
          throw new GatewayError(
            'intenção expirada — confirme com force=true se o dinheiro realmente entrou ' +
              '(a cotação mostrada ao cliente já não vale)',
            'INTENT_EXPIRED',
            false,
          );
        }
        log.warn(
          { reference: intent.reference, expiresAt: intent.expiresAt.toISOString() },
          'confirmando intenção expirada por decisão do operador',
        );
      }

      const event: NormalizedFiatEvent = {
        provider: 'manual',
        // Chave de idempotência da ordem. Derivada da intenção de propósito:
        // uma intenção = no máximo uma ordem, para sempre.
        eventId: `manual_${intent.id}`,
        type: 'payment.completed',
        paymentId: intent.reference,
        customerRef: null,
        fiatCurrency: intent.fiatCurrency as FiatCurrency,
        fiatAmount: intent.fiatAmount.toString(),
        cryptoAmountRaw: intent.expectedInputRaw,
        cryptoMint: config.swap.inputMint,
        customerWallet: intent.customerWallet,
        depositSignature: options.depositSignature ?? intent.depositSignature,
        rawType: `manual.${intent.method.toLowerCase()}.confirmed`,
      };

      // Com retenção em fiat a receita já foi tirada: taxa on-chain zero.
      // Sem retenção (trilho USDC), vale a margem do provedor interno.
      const retainedBps = intent.fiatRetainedBps ?? 0;
      const fee = retainedBps > 0 ? NO_ONCHAIN_FEE : await resolveInternalFee();

      const { order, created } = await createOrderFromEvent(event, {
        fee,
        retained: {
          bps: retainedBps,
          amount: intent.retainedFiatAmount?.toString() ?? '0',
        },
      });

      const updated = await prisma.depositIntent.update({
        where: { id: intent.id },
        data: {
          status: DepositIntentStatus.CONFIRMED,
          orderId: order.id,
          confirmedBy: options.confirmedBy,
          confirmedAt: new Date(),
          ...(options.note !== undefined ? { note: options.note } : {}),
          ...(options.depositSignature !== undefined
            ? { depositSignature: options.depositSignature }
            : {}),
        },
      });

      log.info(
        {
          reference: updated.reference,
          orderId: order.id,
          confirmedBy: options.confirmedBy,
          orderCreated: created,
        },
        'depósito confirmado — ordem entregue à pipeline',
      );

      const pipeline = await dispatchOrderPipeline(order.id);

      /**
       * Avisa a loja assim que o dinheiro entra, sem esperar a entrega do SOL.
       *
       * É o evento que a loja precisa para liberar o pedido dela — e é
       * disparado sem `await` de propósito: um endereço de webhook lento não
       * pode atrasar a confirmação do pagamento aqui.
       */
      if (updated.merchantId !== null) {
        void notifyMerchant(updated.id).catch((err: unknown) =>
          log.warn({ reference: updated.reference, err }, 'notificação à loja falhou'),
        );
      }

      return { intent: updated, orderId: order.id, created, pipeline };
    },
    { ttlMs: 90_000, meta: `confirm:${ref}` },
  );
}

/**
 * Confirma uma intenção de cartão a partir de um pagamento do PSP.
 *
 * A checagem de valor é o que impede o ataque óbvio: pagar 1 real numa
 * intenção de 500. O valor comparado é o `transaction_amount` da API do MP —
 * o que o cliente manda no webhook é só um id.
 *
 * Tolerância de 1 centavo para arredondamento do PSP; nada além disso.
 */
export async function confirmFromPsp(
  reference: string,
  payment: MpPayment,
): Promise<ConfirmResult> {
  const ref = String(reference ?? '').trim().toUpperCase();
  const intent = await prisma.depositIntent.findUnique({ where: { reference: ref } });
  if (!intent) {
    throw new GatewayError(`intenção não encontrada: "${ref}"`, 'INTENT_NOT_FOUND', false);
  }
  if (!payment.approved) {
    throw new GatewayError(
      `pagamento ${payment.id} não está aprovado (status=${payment.status})`,
      'PAYMENT_NOT_APPROVED',
      false,
    );
  }

  const expected = Number(intent.fiatAmount.toString());
  const paid = payment.amount ?? 0;
  if (paid + 0.01 < expected) {
    throw new GatewayError(
      `valor pago (${paid}) é menor que o da intenção (${expected}) — confirmação recusada`,
      'PAYMENT_AMOUNT_MISMATCH',
      false,
      { reference: ref, paid, expected },
    );
  }
  if (payment.currency !== null && payment.currency !== intent.fiatCurrency) {
    throw new GatewayError(
      `moeda do pagamento (${payment.currency}) difere da intenção (${intent.fiatCurrency})`,
      'PAYMENT_CURRENCY_MISMATCH',
      false,
    );
  }

  await prisma.depositIntent.update({
    where: { id: intent.id },
    data: { pspPaymentId: payment.id },
  });

  return confirmIntent(ref, {
    confirmedBy: 'mercadopago',
    note: `pagamento ${payment.id} (${payment.paymentMethod ?? 'cartão'}) aprovado: ${paid} ${payment.currency ?? ''}`.trim(),
    // O dinheiro está aprovado no PSP; a cotação vencida não é motivo para
    // deixar o cliente sem o SOL dele.
    force: true,
  });
}

// ─────────────────── Cobrança pelo checkout próprio ───────────────────

export interface CardFormData {
  token: string;
  paymentMethodId: string;
  installments?: number;
  issuerId?: string | undefined;
  payerEmail: string;
  payerDocType?: string | undefined;
  payerDocNumber?: string | undefined;
}

export interface CardPaymentOutcome {
  status: 'approved' | 'pending' | 'rejected';
  /** Frase pronta para mostrar ao cliente. */
  message: string;
  paymentId: string | null;
  orderId: string | null;
}

/**
 * Cobra o cartão de uma intenção e, se aprovado, dispara a pipeline.
 *
 * O valor cobrado é o da INTENÇÃO, lido do banco. O navegador manda só o token
 * do cartão: se ele mandasse o valor, bastaria alterá-lo no console para
 * comprar 500 reais de SOL pagando 1.
 *
 * O lock por intenção impede a corrida de dois cliques no botão; a chave de
 * idempotência no MP fecha o que sobrar.
 */
export async function payWithCard(
  reference: string,
  form: CardFormData,
): Promise<CardPaymentOutcome> {
  const ref = String(reference ?? '').trim().toUpperCase();
  const found = await prisma.depositIntent.findUnique({ where: { reference: ref } });
  if (!found) {
    throw new GatewayError(`referência não encontrada: "${ref}"`, 'INTENT_NOT_FOUND', false);
  }
  if (found.method !== DepositMethod.CARD) {
    throw new GatewayError(
      'esta referência não é de pagamento com cartão',
      'METHOD_MISMATCH',
      false,
    );
  }
  if (!form.token || !form.paymentMethodId || !form.payerEmail) {
    throw new GatewayError(
      'dados do cartão incompletos (token, meio de pagamento e e-mail são obrigatórios)',
      'INVALID_BODY',
      false,
    );
  }

  return withLockOrThrow(
    LOCK_NAMES.depositIntent(found.id),
    async (): Promise<CardPaymentOutcome> => {
      const intent = await prisma.depositIntent.findUnique({ where: { id: found.id } });
      if (!intent) {
        throw new GatewayError('intenção desapareceu', 'INTENT_NOT_FOUND', false);
      }

      // Já pago: não cobra de novo, só devolve onde a ordem está.
      if (intent.status === DepositIntentStatus.CONFIRMED) {
        return {
          status: 'approved',
          message: 'Pagamento já confirmado.',
          paymentId: intent.pspPaymentId,
          orderId: intent.orderId,
        };
      }
      if (intent.status === DepositIntentStatus.CANCELLED) {
        throw new GatewayError('esta cobrança foi cancelada', 'INTENT_CANCELLED', false);
      }
      // Vencer enquanto o cliente digitava o cartão não pode custar a compra:
      // o preço só muda de verdade depois da janela de tolerância.
      const expiredFor = Date.now() - intent.expiresAt.getTime();
      if (expiredFor > 2 * 3_600_000) {
        throw new GatewayError(
          'esta cobrança expirou — gere uma nova para ter o preço atual',
          'INTENT_EXPIRED',
          false,
        );
      }

      const payment = await createCardPayment({
        reference: intent.reference,
        amount: Number(intent.fiatAmount.toString()),
        description: `Deposito ${intent.reference}`,
        token: form.token,
        paymentMethodId: form.paymentMethodId,
        installments: form.installments ?? 1,
        issuerId: form.issuerId,
        payerEmail: form.payerEmail,
        payerDocType: form.payerDocType,
        payerDocNumber: form.payerDocNumber,
      });

      await prisma.depositIntent.update({
        where: { id: intent.id },
        data: { pspPaymentId: payment.id },
      });

      if (payment.approved) {
        const result = await confirmFromPsp(intent.reference, payment);
        return {
          status: 'approved',
          message: 'Pagamento aprovado. Estamos comprando o seu SOL.',
          paymentId: payment.id,
          orderId: result.orderId,
        };
      }

      // `in_process` é o cartão em análise: o dinheiro pode entrar em minutos.
      // A intenção continua aberta e o poll (ou o webhook) confirma depois.
      const pending = payment.status === 'in_process' || payment.status === 'pending';
      log.warn(
        { reference: intent.reference, paymentId: payment.id, status: payment.status, detail: payment.statusDetail },
        pending ? 'pagamento de cartão em análise' : 'pagamento de cartão recusado',
      );

      return {
        status: pending ? 'pending' : 'rejected',
        message: explainRejection(payment),
        paymentId: payment.id,
        orderId: null,
      };
    },
    { ttlMs: 60_000, meta: `card ${ref}` },
  );
}

export async function cancelIntent(reference: string, note?: string): Promise<DepositIntent> {
  const ref = String(reference ?? '').trim().toUpperCase();
  const intent = await prisma.depositIntent.findUnique({ where: { reference: ref } });
  if (!intent) {
    throw new GatewayError(`intenção não encontrada: "${ref}"`, 'INTENT_NOT_FOUND', false);
  }
  if (intent.status === DepositIntentStatus.CONFIRMED) {
    throw new GatewayError(
      'intenção já confirmada — a ordem está na pipeline e não se cancela por aqui',
      'INTENT_ALREADY_CONFIRMED',
      false,
    );
  }

  return prisma.depositIntent.update({
    where: { id: intent.id },
    data: {
      status: DepositIntentStatus.CANCELLED,
      ...(note !== undefined ? { note } : {}),
    },
  });
}

/**
 * Marca como EXPIRED o que passou do TTL sem pagamento.
 *
 * Só higiene de estado: não é erro, e uma intenção expirada ainda pode ser
 * confirmada com `force` se o dinheiro entrar atrasado.
 */
export async function expireStaleIntents(): Promise<number> {
  const result = await prisma.depositIntent.updateMany({
    where: {
      status: DepositIntentStatus.AWAITING_PAYMENT,
      expiresAt: { lt: new Date() },
    },
    data: { status: DepositIntentStatus.EXPIRED },
  });
  if (result.count > 0) log.info({ count: result.count }, 'intenções expiradas');
  return result.count;
}

// ─────────────────── Entrega da chave da carteira gerada ───────────────────

/**
 * Devolve a chave privada da carteira que geramos para este depósito.
 *
 * A `reference` sozinha NÃO basta: ela viaja na URL, aparece em prints e fica
 * no histórico do navegador. Quem pede a chave precisa apresentar o token de
 * posse devolvido na criação da intenção — comparado em tempo constante contra
 * o hash guardado.
 *
 * Isto não é autenticação de usuário (não existe conta aqui); é o mínimo que
 * impede que ver uma referência signifique poder levar o dinheiro.
 */
export async function revealWalletSecret(
  reference: string,
  claimToken: string,
): Promise<RevealedSecret> {
  const ref = String(reference ?? '').trim().toUpperCase();
  const intent = await prisma.depositIntent.findUnique({ where: { reference: ref } });
  if (!intent) {
    throw new GatewayError(`referência não encontrada: "${ref}"`, 'INTENT_NOT_FOUND', false);
  }
  if (intent.walletId === null) {
    throw new GatewayError(
      'esta ordem foi paga numa carteira sua — não temos chave privada dela',
      'WALLET_NOT_CUSTODIAL',
      false,
    );
  }
  if (intent.claimTokenHash === null) {
    throw new GatewayError(
      'esta carteira não tem token de posse registrado — recuperação só pelo painel',
      'CLAIM_TOKEN_MISSING',
      false,
    );
  }

  const provided = String(claimToken ?? '');
  const providedHash = crypto.createHash('sha256').update(provided).digest();
  const expectedHash = Buffer.from(intent.claimTokenHash, 'hex');

  if (
    provided.length === 0 ||
    providedHash.length !== expectedHash.length ||
    !crypto.timingSafeEqual(providedHash, expectedHash)
  ) {
    log.warn({ reference: ref }, 'pedido de chave privada com token inválido');
    throw new GatewayError(
      'token de posse inválido — a chave só é entregue ao navegador que criou o depósito',
      'INVALID_CLAIM_TOKEN',
      false,
    );
  }

  return revealSecret(intent.walletId);
}

// ─────────────────────────── Leitura ───────────────────────────

/** Formata base units como decimal humano sem passar por float. */
export function formatBaseUnits(raw: bigint, decimals: number): string {
  const str = raw.toString().padStart(decimals + 1, '0');
  const whole = str.slice(0, str.length - decimals);
  if (decimals === 0) return whole;
  return `${whole}.${str.slice(str.length - decimals)}`;
}

function amountToPay(intent: DepositIntent): string {
  if (intent.method === DepositMethod.USDC) {
    return `${formatBaseUnits(intent.expectedInputRaw, config.swap.inputMintDecimals)} USDC`;
  }
  return `${intent.fiatAmount.toString()} ${intent.fiatCurrency}`;
}

/** Total retido em fiat, por moeda — a receita que vive fora da chain. */
export async function getRetainedFiatTotals(): Promise<
  Array<{ currency: string; total: string; orders: number }>
> {
  const grouped = await prisma.order.groupBy({
    by: ['fiatCurrency'],
    where: { retainedFiatAmount: { not: null } },
    _sum: { retainedFiatAmount: true },
    _count: { _all: true },
  });
  return grouped.map((g) => ({
    currency: g.fiatCurrency,
    total: (g._sum.retainedFiatAmount ?? new Prisma.Decimal(0)).toString(),
    orders: g._count._all,
  }));
}

/** Visão do checkout público. Sem `clientIp`, sem `note`, sem nada do vault. */
export async function getPublicView(reference: string): Promise<DepositIntentPublicView> {
  const ref = String(reference ?? '').trim().toUpperCase();
  const intent = await prisma.depositIntent.findUnique({ where: { reference: ref } });
  if (!intent) {
    throw new GatewayError(`referência não encontrada: "${ref}"`, 'INTENT_NOT_FOUND', false);
  }

  const order =
    intent.orderId === null
      ? null
      : await prisma.order.findUnique({ where: { id: intent.orderId } });

  return {
    reference: intent.reference,
    method: intent.method as DepositMethod,
    fiatCurrency: intent.fiatCurrency as FiatCurrency,
    fiatAmount: intent.fiatAmount.toString(),
    customerWallet: intent.customerWallet,
    status: intent.status as DepositIntentPublicView['status'],
    amountToPay: amountToPay(intent),
    instructions: instructionsFor(intent.method as DepositMethod, intent.reference),
    quotedFeeBps: intent.quotedFeeBps,
    quotedCustomerSol: intent.quotedCustomerSol,
    /**
     * A composição do preço (retenção, taxa de rede, margem) NÃO vai para o
     * navegador.
     *
     * Não é só uma escolha de tela: dado que não sai do servidor não pode ser
     * lido no DevTools nem na resposta da API. O cliente vê o negócio — quanto
     * paga e quanto recebe —, que é o que ele precisa para decidir; a planilha
     * do operador fica no painel.
     */
    wallet: {
      address: intent.customerWallet,
      /** true = geramos e guardamos a chave; o cliente pode pedi-la. */
      generated: intent.walletId !== null,
    },
    pix:
      intent.pixCopyPaste === null
        ? null
        : {
            copyPaste: intent.pixCopyPaste,
            qrBase64: intent.pixQrBase64,
            expiresAt: intent.pixExpiresAt?.toISOString() ?? null,
          },
    // Some depois de paga: um link de checkout já usado só confunde.
    checkoutUrl:
      intent.status === DepositIntentStatus.AWAITING_PAYMENT ? intent.pspCheckoutUrl : null,
    expiresAt: intent.expiresAt.toISOString(),
    createdAt: intent.createdAt.toISOString(),
    order:
      order === null
        ? null
        : {
            id: order.id,
            status: order.status as OrderStatus,
            customerSol:
              order.customerLamports === null
                ? null
                : Number(order.customerLamports) / LAMPORTS_PER_SOL,
            swapSignature: order.swapSignature,
            payoutSignature: order.customerPayoutSignature,
            // O cliente merece saber que travou; a mensagem é técnica, mas é
            // melhor do que uma tela girando para sempre.
            lastError: order.lastError,
          },
  };
}

/** Fila do operador: o que está esperando dinheiro, o que já entrou. */
export async function listIntents(
  options: { status?: string; limit?: number } = {},
): Promise<
  Array<{
    reference: string;
    method: string;
    status: string;
    fiat: string;
    expectedUsdc: string;
    customerWallet: string;
    orderId: string | null;
    orderStatus: string | null;
    quotedFeeBps: number | null;
    quotedCustomerSol: string | null;
    retainedFiat: string | null;
    retainedBps: number | null;
    pspPaymentId: string | null;
    depositSignature: string | null;
    confirmedBy: string | null;
    note: string | null;
    expiresAt: string;
    expired: boolean;
    createdAt: string;
    confirmedAt: string | null;
  }>
> {
  const limit = Math.min(Math.max(options.limit ?? 30, 1), 100);
  const intents = await prisma.depositIntent.findMany({
    ...(options.status ? { where: { status: options.status } } : {}),
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  const orderIds = intents.map((i) => i.orderId).filter((id): id is string => id !== null);
  const orders =
    orderIds.length === 0
      ? []
      : await prisma.order.findMany({
          where: { id: { in: orderIds } },
          select: { id: true, status: true },
        });
  const statusById = new Map(orders.map((o) => [o.id, o.status]));

  const decimals = config.swap.inputMintDecimals;
  const now = Date.now();

  return intents.map((i) => ({
    reference: i.reference,
    method: i.method,
    status: i.status,
    fiat: `${i.fiatAmount.toString()} ${i.fiatCurrency}`,
    expectedUsdc: formatBaseUnits(i.expectedInputRaw, decimals),
    customerWallet: i.customerWallet,
    orderId: i.orderId,
    orderStatus: i.orderId === null ? null : (statusById.get(i.orderId) ?? null),
    quotedFeeBps: i.quotedFeeBps,
    quotedCustomerSol: i.quotedCustomerSol,
    retainedFiat: i.retainedFiatAmount?.toString() ?? null,
    retainedBps: i.fiatRetainedBps,
    pspPaymentId: i.pspPaymentId,
    depositSignature: i.depositSignature,
    confirmedBy: i.confirmedBy,
    note: i.note,
    expiresAt: i.expiresAt.toISOString(),
    expired: i.expiresAt.getTime() < now,
    createdAt: i.createdAt.toISOString(),
    confirmedAt: i.confirmedAt?.toISOString() ?? null,
  }));
}
