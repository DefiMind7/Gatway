import { Prisma, type DepositIntent, type Merchant } from '@prisma/client';
import { PublicKey } from '@solana/web3.js';
import { config, LAMPORTS_PER_SOL, TOTAL_BPS } from '../config';
import { prisma } from '../database/client';
import { GatewayError, OrderStatus } from '../types';
import { logger } from '../utils/logger';
import { NotificationKind, notify } from './merchant-notify.service';
import { getDepositRates } from './deposit.service';
import { createOrderFromEvent, dispatchOrderPipeline } from './order.service';

/**
 * Saldo e saques das lojas.
 *
 * O modelo é o de qualquer adquirente: o cliente da loja paga em reais, o
 * dinheiro entra na conta do gateway, e a loja passa a ter **saldo**. Ela
 * acompanha o faturamento e pede saque quando quiser — e o saque sai em SOL.
 *
 * Duas decisões estruturais:
 *
 *  • **o saldo é a soma dos lançamentos**, nunca um número guardado. Um campo
 *    que se atualiza a cada venda diverge do histórico no primeiro erro, e aí
 *    não há como saber qual dos dois é verdade;
 *  • **a comissão fica gravada no lançamento**, não só no cadastro da loja.
 *    Mudar a comissão amanhã não pode reescrever o que já foi vendido.
 */

const log = logger.child({ scope: 'merchant-ledger' });

export const LedgerType = { VENDA: 'venda', SAQUE: 'saque', AJUSTE: 'ajuste' } as const;
export const WithdrawalStatus = {
  PENDENTE: 'pendente',
  APROVADO: 'aprovado',
  ENVIADO: 'enviado',
  RECUSADO: 'recusado',
} as const;

// ─────────────────────────── Senha do portal ───────────────────────────

/**
 * Reexportados do módulo único de senha.
 *
 * Viviam aqui, com uma segunda cópia do scrypt — e as duas cópias derivaram
 * parâmetros diferentes ao longo do tempo. Um lugar só para isto é o que
 * garante que reforçar o custo reforce para todo mundo.
 */
export { hashPassword as hashMerchantPassword } from '../utils/password';
export { verifyPassword as verifyMerchantPasswordDetailed } from '../utils/password';

// ─────────────────────────── Crédito de venda ───────────────────────────

/**
 * Credita a loja por uma venda paga.
 *
 * Idempotente pelo `intentId`, que é UNIQUE: webhook, poll e reconciliação
 * podem chegar juntos sobre a mesma cobrança e o crédito acontece uma vez só.
 */
export async function creditSale(intent: DepositIntent, merchant: Merchant): Promise<void> {
  const bruto = new Prisma.Decimal(intent.fiatAmount.toString());
  const bps = merchant.commissionBps;
  const comissao = bruto.mul(bps).div(TOTAL_BPS).toDecimalPlaces(2);
  const liquido = bruto.sub(comissao);

  try {
    await prisma.merchantLedgerEntry.create({
      data: {
        merchantId: merchant.id,
        type: LedgerType.VENDA,
        amount: liquido,
        currency: intent.fiatCurrency,
        commissionAmount: comissao,
        commissionBps: bps,
        intentId: intent.id,
        description: `Venda ${intent.reference}`,
      },
    });

    log.info(
      {
        merchantId: merchant.id,
        reference: intent.reference,
        bruto: bruto.toString(),
        comissao: comissao.toString(),
        liquido: liquido.toString(),
      },
      'venda creditada à loja',
    );
  } catch (err) {
    // P2002 = já existe lançamento para esta cobrança. É o caminho normal
    // quando dois caminhos de confirmação chegam juntos.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      log.debug({ reference: intent.reference }, 'venda já creditada — ignorando');
      return;
    }
    throw err;
  }
}

// ─────────────────────────── Saldo ───────────────────────────

export interface MerchantBalance {
  /** Disponível para saque. */
  available: string;
  /** Somatório das vendas líquidas. */
  totalSales: string;
  /** Já sacado (inclui saques em andamento). */
  totalWithdrawn: string;
  /** Comissão que ficou com o gateway. */
  totalCommission: string;
  salesCount: number;
  currency: string;
}

export async function getBalance(merchantId: string): Promise<MerchantBalance> {
  const [agregado, vendas, saques] = await Promise.all([
    prisma.merchantLedgerEntry.aggregate({
      where: { merchantId },
      _sum: { amount: true, commissionAmount: true },
    }),
    prisma.merchantLedgerEntry.aggregate({
      where: { merchantId, type: LedgerType.VENDA },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.merchantLedgerEntry.aggregate({
      where: { merchantId, type: LedgerType.SAQUE },
      _sum: { amount: true },
    }),
  ]);

  const zero = new Prisma.Decimal(0);
  const disponivel = agregado._sum.amount ?? zero;

  return {
    available: disponivel.toFixed(2),
    totalSales: (vendas._sum.amount ?? zero).toFixed(2),
    // Débitos são negativos no razão; o total sacado é o valor absoluto.
    totalWithdrawn: (saques._sum.amount ?? zero).abs().toFixed(2),
    totalCommission: (agregado._sum.commissionAmount ?? zero).toFixed(2),
    salesCount: vendas._count._all,
    currency: 'BRL',
  };
}

export interface LedgerLine {
  id: string;
  type: string;
  amount: string;
  commission: string | null;
  description: string | null;
  createdAt: string;
}

export async function getLedger(merchantId: string, limit = 50): Promise<LedgerLine[]> {
  const linhas = await prisma.merchantLedgerEntry.findMany({
    where: { merchantId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  return linhas.map((l) => ({
    id: l.id,
    type: l.type,
    amount: l.amount.toFixed(2),
    commission: l.commissionAmount?.toFixed(2) ?? null,
    description: l.description,
    createdAt: l.createdAt.toISOString(),
  }));
}

// ─────────────────────────── Saque ───────────────────────────

/** Piso do saque: abaixo disso a taxa de rede come uma fração absurda. */
const MIN_SAQUE = new Prisma.Decimal(10);

export const PayoutMethod = { SOL: 'SOL', FIAT: 'FIAT' } as const;
export const MOEDAS_SAQUE = ['BRL', 'USD', 'EUR'] as const;

/**
 * Converte entre a moeda do saldo e a moeda de saída.
 *
 * Usa o câmbio do OPERADOR (`depositRatesJson`), que é quantos USDC valem uma
 * unidade de cada moeda. Passar por USDC como pivô mantém uma única tabela de
 * câmbio no sistema — inventar uma segunda seria criar duas verdades sobre o
 * mesmo número.
 *
 * O resultado é estimativa: quem paga em fiat é o operador, pelo câmbio do
 * banco dele no dia. Por isso o valor efetivamente enviado é registrado à
 * parte, e é ele que vale.
 */
export async function convertFiat(
  amount: Prisma.Decimal,
  from: string,
  to: string,
): Promise<Prisma.Decimal> {
  if (from === to) return amount;

  const rates = await getDepositRates();
  const origem = rates[from];
  const destino = rates[to];

  if (!origem || !destino) {
    throw new GatewayError(
      `sem câmbio configurado para ${from}→${to} — defina em Câmbio do operador`,
      'MISSING_RATE',
      false,
    );
  }

  // amount(from) → USDC → to
  return amount.mul(origem).div(destino).toDecimalPlaces(2);
}

export async function requestWithdrawal(input: {
  merchant: Merchant;
  amountFiat: number;
  /** `SOL` entrega on-chain; `FIAT` é transferência feita pelo operador. */
  payoutMethod?: string | undefined;
  destinationWallet?: string | undefined;
  payoutCurrency?: string | undefined;
  payoutDetails?: string | undefined;
  clientIp?: string | undefined;
}): Promise<{
  id: string;
  amountFiat: string;
  payoutMethod: string;
  destination: string;
  estimated: string | null;
  payoutCurrency: string;
}> {
  const metodo =
    String(input.payoutMethod ?? input.merchant.preferredPayout ?? PayoutMethod.SOL).toUpperCase() ===
    PayoutMethod.FIAT
      ? PayoutMethod.FIAT
      : PayoutMethod.SOL;

  let carteira = '';
  let dadosFiat = '';
  let moedaSaida = 'BRL';

  if (metodo === PayoutMethod.SOL) {
    carteira = (input.destinationWallet ?? input.merchant.payoutWallet ?? '').trim();

    if (!carteira) {
      throw new GatewayError(
        'defina a carteira Solana que vai receber o saque',
        'MISSING_PAYOUT_WALLET',
        false,
      );
    }
    try {
      new PublicKey(carteira);
    } catch {
      throw new GatewayError(`carteira Solana inválida: "${carteira}"`, 'INVALID_WALLET', false);
    }
    if (carteira === config.solana.vaultPublicKey.toBase58()) {
      throw new GatewayError('essa é a carteira do gateway', 'DESTINATION_IS_VAULT', false);
    }
  } else {
    dadosFiat = (input.payoutDetails ?? input.merchant.payoutFiatDetails ?? '').trim();
    moedaSaida = String(input.payoutCurrency ?? input.merchant.payoutCurrency ?? 'BRL').toUpperCase();

    if (!dadosFiat) {
      throw new GatewayError(
        'informe a conta que vai receber: chave Pix, IBAN ou dados bancários',
        'MISSING_PAYOUT_DETAILS',
        false,
      );
    }
    if (!MOEDAS_SAQUE.includes(moedaSaida as never)) {
      throw new GatewayError(
        `moeda não aceita: ${moedaSaida}. Use ${MOEDAS_SAQUE.join(', ')}`,
        'INVALID_CURRENCY',
        false,
      );
    }
  }

  const valor = new Prisma.Decimal(Number(input.amountFiat).toFixed(2));
  if (valor.lessThan(MIN_SAQUE)) {
    throw new GatewayError(
      `o saque mínimo é ${MIN_SAQUE.toFixed(2)} — abaixo disso a taxa de rede pesa demais`,
      'AMOUNT_TOO_SMALL',
      false,
    );
  }

  const saldo = await getBalance(input.merchant.id);
  if (valor.greaterThan(new Prisma.Decimal(saldo.available))) {
    throw new GatewayError(
      `saldo insuficiente: disponível ${saldo.available}`,
      'INSUFFICIENT_BALANCE',
      false,
      { available: saldo.available },
    );
  }

  // Estimativa na moeda de saída. Só informativa: quem transfere é o operador,
  // pelo câmbio do banco dele.
  const estimado =
    metodo === PayoutMethod.FIAT ? await convertFiat(valor, 'BRL', moedaSaida) : null;

  /**
   * O débito acontece AGORA, junto do pedido, numa transação.
   *
   * Debitar só na aprovação deixaria a loja pedir dois saques do mesmo saldo
   * enquanto o primeiro espera análise — e o segundo seria aprovado sobre
   * dinheiro que já não existe.
   */
  const saque = await prisma.$transaction(async (tx) => {
    const criado = await tx.merchantWithdrawal.create({
      data: {
        merchantId: input.merchant.id,
        amountFiat: valor,
        currency: 'BRL',
        payoutMethod: metodo,
        destinationWallet: carteira,
        payoutDetails: dadosFiat || null,
        payoutCurrency: moedaSaida,
        estimatedAmount: estimado,
        status: WithdrawalStatus.PENDENTE,
        ...(input.clientIp !== undefined ? { clientIp: input.clientIp } : {}),
      },
    });

    await tx.merchantLedgerEntry.create({
      data: {
        merchantId: input.merchant.id,
        type: LedgerType.SAQUE,
        amount: valor.negated(),
        currency: 'BRL',
        withdrawalId: criado.id,
        description:
          metodo === PayoutMethod.SOL
            ? `Saque em SOL para ${carteira.slice(0, 4)}…${carteira.slice(-4)}`
            : `Saque em ${moedaSaida} (transferência)`,
      },
    });

    return criado;
  });

  log.warn(
    {
      merchantId: input.merchant.id,
      saqueId: saque.id,
      valor: valor.toString(),
      metodo,
      destino: metodo === PayoutMethod.SOL ? carteira : moedaSaida,
    },
    'loja pediu saque',
  );

  return {
    id: saque.id,
    amountFiat: valor.toFixed(2),
    payoutMethod: metodo,
    destination: metodo === PayoutMethod.SOL ? carteira : dadosFiat,
    estimated: estimado?.toFixed(2) ?? null,
    payoutCurrency: moedaSaida,
  };
}

/**
 * Registra que o operador transferiu um saque em fiat.
 *
 * Não há automação possível aqui: quem faz a transferência é uma pessoa, no
 * banco. O que o sistema garante é o registro — quanto saiu, em que moeda, e
 * com qual comprovante — para o saldo e o histórico da loja baterem.
 */
export async function markFiatSent(
  id: string,
  input: { sentAmount?: number | undefined; note?: string | undefined },
): Promise<void> {
  const saque = await prisma.merchantWithdrawal.findUnique({ where: { id } });
  if (!saque) throw new GatewayError('saque não encontrado', 'NOT_FOUND', false);

  if (saque.payoutMethod !== PayoutMethod.FIAT) {
    throw new GatewayError(
      'este saque é em cripto — aprove para a pipeline enviar',
      'NOT_FIAT',
      false,
    );
  }
  if (saque.status === WithdrawalStatus.ENVIADO) {
    throw new GatewayError('este saque já foi marcado como enviado', 'ALREADY_SENT', false);
  }
  if (saque.status === WithdrawalStatus.RECUSADO) {
    throw new GatewayError('este saque foi recusado', 'INVALID_STATUS', false);
  }

  await prisma.merchantWithdrawal.update({
    where: { id },
    data: {
      status: WithdrawalStatus.ENVIADO,
      sentAmount:
        input.sentAmount !== undefined
          ? new Prisma.Decimal(Number(input.sentAmount).toFixed(2))
          : saque.estimatedAmount,
      reviewNote: input.note?.trim() || saque.reviewNote,
      reviewedAt: saque.reviewedAt ?? new Date(),
      completedAt: new Date(),
    },
  });

  await notify(
    saque.merchantId,
    NotificationKind.SAQUE,
    'Saque transferido',
    `${saque.amountFiat.toString()} ${saque.currency} enviados em ${saque.payoutCurrency}` +
      (input.note?.trim() ? ` — ${input.note.trim()}` : '') + '.',
    'saques',
  );

  log.warn({ saqueId: id, moeda: saque.payoutCurrency }, 'saque em fiat marcado como enviado');
}

export interface WithdrawalLine {
  id: string;
  merchantId: string;
  merchantName: string;
  amountFiat: string;
  currency: string;
  payoutMethod: string;
  payoutCurrency: string;
  payoutDetails: string | null;
  estimatedAmount: string | null;
  sentAmount: string | null;
  destinationWallet: string;
  status: string;
  orderId: string | null;
  signature: string | null;
  solSent: string | null;
  reviewNote: string | null;
  createdAt: string;
  completedAt: string | null;
}

export async function listWithdrawals(options: {
  merchantId?: string | undefined;
  status?: string | undefined;
  limit?: number;
} = {}): Promise<WithdrawalLine[]> {
  const saques = await prisma.merchantWithdrawal.findMany({
    where: {
      ...(options.merchantId ? { merchantId: options.merchantId } : {}),
      ...(options.status ? { status: options.status } : {}),
    },
    include: { merchant: { select: { name: true } } },
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    take: options.limit ?? 50,
  });

  return saques.map((s) => ({
    id: s.id,
    merchantId: s.merchantId,
    merchantName: s.merchant.name,
    amountFiat: s.amountFiat.toFixed(2),
    currency: s.currency,
    payoutMethod: s.payoutMethod,
    payoutCurrency: s.payoutCurrency,
    payoutDetails: s.payoutDetails,
    estimatedAmount: s.estimatedAmount?.toFixed(2) ?? null,
    sentAmount: s.sentAmount?.toFixed(2) ?? null,
    destinationWallet: s.destinationWallet,
    status: s.status,
    orderId: s.orderId,
    signature: s.signature,
    solSent: s.solSent,
    reviewNote: s.reviewNote,
    createdAt: s.createdAt.toISOString(),
    completedAt: s.completedAt?.toISOString() ?? null,
  }));
}

/**
 * Aprova o saque: cria a ordem que converte fiat em SOL e entrega.
 *
 * Reaproveita a pipeline inteira — o mesmo caminho que atende um cliente
 * comprando SOL. Para ela, isto é só mais uma ordem: swap do USDC do float,
 * liquidação para a carteira de destino, retomada automática se algo falhar.
 *
 * O valor em SOL não é decidido aqui: sai da cotação no instante do swap. Uma
 * promessa fixada no pedido seria desmentida pelo mercado entre um e outro.
 */
export async function approveWithdrawal(
  id: string,
  note?: string,
): Promise<{ orderId: string; usdcNeeded: string }> {
  const saque = await prisma.merchantWithdrawal.findUnique({ where: { id } });
  if (!saque) throw new GatewayError('saque não encontrado', 'NOT_FOUND', false);
  if (saque.status !== WithdrawalStatus.PENDENTE) {
    throw new GatewayError(
      `só saques pendentes podem ser aprovados (este está ${saque.status})`,
      'INVALID_STATUS',
      false,
    );
  }
  if (saque.payoutMethod === PayoutMethod.FIAT) {
    throw new GatewayError(
      'este saque é em fiat: faça a transferência e use "marcar como enviado"',
      'IS_FIAT',
      false,
    );
  }

  const rates = await getDepositRates();
  const rate = rates[saque.currency] ?? 1;
  const inputRaw = BigInt(
    Math.round(Number(saque.amountFiat.toString()) * rate * 10 ** config.swap.inputMintDecimals),
  );

  const { order } = await createOrderFromEvent(
    {
      provider: 'manual',
      // Idempotência: um saque gera no máximo uma ordem, para sempre.
      eventId: `withdrawal_${saque.id}`,
      type: 'payment.completed',
      paymentId: saque.id,
      customerRef: saque.merchantId,
      fiatCurrency: saque.currency as never,
      fiatAmount: saque.amountFiat.toString(),
      cryptoAmountRaw: inputRaw,
      cryptoMint: config.swap.inputMint,
      customerWallet: saque.destinationWallet,
      depositSignature: null,
      rawType: 'merchant.withdrawal',
    },
    {
      // A comissão já foi tirada na venda; o saque entrega o líquido inteiro.
      fee: {
        providerCostBps: 0,
        marginBps: 0,
        feeBps: 0,
        sourceProvider: 'internal',
        clamped: false,
      },
    },
  );

  await prisma.merchantWithdrawal.update({
    where: { id },
    data: {
      status: WithdrawalStatus.APROVADO,
      orderId: order.id,
      reviewNote: note?.trim() || null,
      reviewedAt: new Date(),
    },
  });

  log.warn(
    { saqueId: id, orderId: order.id, valor: saque.amountFiat.toString() },
    'saque aprovado — ordem de conversão criada',
  );

  void dispatchOrderPipeline(order.id).catch((err: unknown) =>
    log.error({ saqueId: id, err }, 'pipeline do saque falhou ao iniciar'),
  );

  return {
    orderId: order.id,
    usdcNeeded: (Number(inputRaw) / 10 ** config.swap.inputMintDecimals).toFixed(2),
  };
}

/**
 * Marca como enviados os saques cuja ordem já liquidou.
 *
 * O saque não fica sabendo da entrega sozinho: quem conclui a ordem é a
 * pipeline, que não conhece o conceito de saque. Esta varredura fecha o ciclo
 * e é chamada pelo mesmo tick que retoma ordens.
 */
export async function syncWithdrawals(): Promise<{ concluidos: number }> {
  const emVoo = await prisma.merchantWithdrawal.findMany({
    where: {
      status: WithdrawalStatus.APROVADO,
      payoutMethod: PayoutMethod.SOL,
      orderId: { not: null },
    },
    take: 50,
  });
  if (emVoo.length === 0) return { concluidos: 0 };

  const ordens = await prisma.order.findMany({
    where: { id: { in: emVoo.map((s) => s.orderId!) } },
    select: {
      id: true,
      status: true,
      customerLamports: true,
      customerPayoutSignature: true,
    },
  });
  const porId = new Map(ordens.map((o) => [o.id, o]));

  let concluidos = 0;
  for (const saque of emVoo) {
    const ordem = porId.get(saque.orderId!);
    if (!ordem) continue;

    const entregue =
      ordem.status === OrderStatus.SETTLED || ordem.status === OrderStatus.DISTRIBUTED;
    if (!entregue || ordem.customerPayoutSignature === null) continue;

    await prisma.merchantWithdrawal.update({
      where: { id: saque.id },
      data: {
        status: WithdrawalStatus.ENVIADO,
        signature: ordem.customerPayoutSignature,
        solSent: (Number(ordem.customerLamports ?? 0n) / LAMPORTS_PER_SOL).toFixed(9),
        completedAt: new Date(),
      },
    });
    await notify(
      saque.merchantId,
      NotificationKind.SAQUE,
      'Saque enviado em SOL',
      `${(Number(ordem.customerLamports ?? 0n) / LAMPORTS_PER_SOL).toFixed(6)} SOL na carteira ` +
        `${saque.destinationWallet.slice(0, 8)}… — confira o comprovante na aba Saques.`,
      'saques',
    );

    concluidos += 1;
    log.info({ saqueId: saque.id, signature: ordem.customerPayoutSignature }, 'saque entregue');
  }

  return { concluidos };
}

/** Devolve o valor ao saldo quando o operador recusa. */
export async function rejectWithdrawal(id: string, note?: string): Promise<void> {
  const saque = await prisma.merchantWithdrawal.findUnique({ where: { id } });
  if (!saque) throw new GatewayError('saque não encontrado', 'NOT_FOUND', false);
  if (saque.status !== WithdrawalStatus.PENDENTE) {
    throw new GatewayError(
      `só saques pendentes podem ser recusados (este está ${saque.status})`,
      'INVALID_STATUS',
      false,
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.merchantWithdrawal.update({
      where: { id },
      data: {
        status: WithdrawalStatus.RECUSADO,
        reviewNote: note?.trim() || null,
        reviewedAt: new Date(),
      },
    });

    // Estorna: o débito entrou no pedido, então a recusa precisa devolver.
    await tx.merchantLedgerEntry.create({
      data: {
        merchantId: saque.merchantId,
        type: LedgerType.AJUSTE,
        amount: saque.amountFiat,
        currency: saque.currency,
        description: `Estorno do saque recusado${note ? `: ${note.slice(0, 120)}` : ''}`,
      },
    });
  });

  await notify(
    saque.merchantId,
    NotificationKind.SAQUE,
    'Saque recusado',
    (note?.trim() ? note.trim() + ' ' : '') +
      `O valor de ${saque.amountFiat.toString()} ${saque.currency} voltou para o seu saldo.`,
    'saques',
  );

  log.warn({ saqueId: id }, 'saque recusado e valor devolvido ao saldo');
}
