/** Interfaces globais do gateway. */

// ─────────────────────────── Máquina de estados ───────────────────────────

export const OrderStatus = {
  /** Webhook aceito e persistido. Nada on-chain ainda. */
  PENDING: 'PENDING',
  /** Pipeline em execução (deposit check / swap em voo). */
  PROCESSING: 'PROCESSING',
  /** Swap confirmado: o SOL desta ordem está no vault. */
  SWAPPED: 'SWAPPED',
  /** Cliente já recebeu a parte dele; o lucro está retido no vault. */
  SETTLED: 'SETTLED',
  /** O lucro desta ordem entrou num PayoutRun concluído. Estado final. */
  DISTRIBUTED: 'DISTRIBUTED',
  /** Esgotou tentativas ou erro irrecuperável. Exige intervenção. */
  FAILED: 'FAILED',
} as const;

export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export const PayoutRunStatus = {
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  /** Parte dos lotes foi paga; retomável. */
  PARTIAL: 'PARTIAL',
  FAILED: 'FAILED',
  /** Nada a distribuir ou abaixo do mínimo — não é erro. */
  SKIPPED: 'SKIPPED',
} as const;

export type PayoutRunStatus = (typeof PayoutRunStatus)[keyof typeof PayoutRunStatus];

export const PayoutStatus = {
  PENDING: 'PENDING',
  SENT: 'SENT',
  FAILED: 'FAILED',
} as const;

export type PayoutStatus = (typeof PayoutStatus)[keyof typeof PayoutStatus];

export const FiatCurrency = {
  EUR: 'EUR',
  USD: 'USD',
  BRL: 'BRL',
} as const;

export type FiatCurrency = (typeof FiatCurrency)[keyof typeof FiatCurrency];

export const SUPPORTED_CURRENCIES: readonly FiatCurrency[] = [
  FiatCurrency.EUR,
  FiatCurrency.USD,
  FiatCurrency.BRL,
];

// ─────────────────────────── Webhook (fiat) ───────────────────────────

/**
 * Forma normalizada de um evento de pagamento, independente do provedor.
 * Os adapters (SpherePay / MoonPay) traduzem para cá.
 */
export interface NormalizedFiatEvent {
  /**
   * `manual` é o provedor INTERNO (ver `deposit.service.ts`): o operador
   * recebe o dinheiro por um trilho próprio e confirma. O evento tem
   * exatamente a mesma forma dos externos, por isso a pipeline não muda.
   */
  provider: 'spherepay' | 'moonpay' | 'manual' | 'mercadopago';
  /** Chave de idempotência: id do evento no provedor. */
  eventId: string;
  /** Tipo já normalizado. Só `payment.completed` dispara a pipeline. */
  type: 'payment.completed' | 'payment.failed' | 'payment.pending' | 'unknown';
  paymentId: string | null;
  customerRef: string | null;
  fiatCurrency: FiatCurrency;
  fiatAmount: string;
  /** Base units do stablecoin creditado (USDC 6 decimais). */
  cryptoAmountRaw: bigint;
  cryptoMint: string;
  /**
   * Carteira do CLIENTE — destino do SOL menos a taxa (modelo broker).
   * Obrigatória: sem ela não há como liquidar a ordem.
   */
  customerWallet: string | null;
  /** Assinatura da tx de settlement do on-ramp, se o provedor já a conhece. */
  depositSignature: string | null;
  rawType: string;
}

export interface SignatureVerification {
  valid: boolean;
  reason?: string;
  timestamp?: number;
}

/** Body do Express com o buffer cru preservado (necessário para o HMAC). */
export interface RawBodyRequest {
  rawBody?: Buffer;
}

// ─────────────────────────── Jupiter v6 ───────────────────────────

export interface JupiterQuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: JupiterRoutePlanStep[];
  contextSlot?: number;
  timeTaken?: number;
}

export interface JupiterRoutePlanStep {
  swapInfo: {
    ammKey: string;
    label?: string;
    inputMint: string;
    outputMint: string;
    inAmount: string;
    outAmount: string;
    feeAmount: string;
    feeMint: string;
  };
  percent: number;
}

export interface JupiterSwapResponse {
  /** VersionedTransaction serializada em base64, ainda não assinada. */
  swapTransaction: string;
  lastValidBlockHeight: number;
  prioritizationFeeLamports?: number;
  computeUnitLimit?: number;
}

export interface SwapResult {
  signature: string;
  /** Delta real de lamports no vault (o que importa para o rateio). */
  lamportsReceived: bigint;
  quotedOutLamports: bigint;
  priceImpactPct: string;
}

// ─────────────────────── Taxas dos on-ramps ───────────────────────

export type FeeProviderName = 'moonpay' | 'transak' | 'ramp' | 'spherepay';

/** Cotação de custo de um on-ramp para um par (moeda, valor). */
export interface ProviderFeeQuote {
  provider: FeeProviderName;
  /** Custo total do provedor em bps sobre o valor fiat. */
  costBps: number;
  /** Custo bruto reportado pelo provedor, para auditoria. */
  rawFeeAmount: string | null;
  available: boolean;
  error?: string;
  /** true quando o adapter nunca foi validado contra a API real. */
  unverified: boolean;
}

export interface FeeComparison {
  fiatCurrency: FiatCurrency;
  fiatAmount: string;
  quotes: ProviderFeeQuote[];
  /** O mais barato disponível — a escolha "sempre o melhor". */
  best: ProviderFeeQuote | null;
  /** true quando nenhum provedor respondeu e usamos o fallback. */
  usedFallback: boolean;
  collectedAt: string;
  fromCache: boolean;
}

/** Taxa efetiva aplicada a uma operação. */
export interface EffectiveFee {
  providerCostBps: number;
  marginBps: number;
  /** providerCostBps + marginBps, limitado por minFeeBps/maxFeeBps. */
  feeBps: number;
  /** `internal` = depósito pelo provedor interno: não há custo de on-ramp. */
  sourceProvider: FeeProviderName | 'fallback' | 'internal';
  clamped: boolean;
}

// ─────────────────────────── Distribuição ───────────────────────────

export interface RecipientConfig {
  label: string;
  address: string;
  bps: number;
}

/** Resultado do cálculo do split: soma dos lamports === total, sempre. */
export interface SplitAllocation extends RecipientConfig {
  lamports: bigint;
  /** true no destinatário que absorveu o resto da divisão inteira. */
  absorbedRemainder: boolean;
}

export interface DistributionBatchResult {
  batchIndex: number;
  signature: string;
  addresses: string[];
  lamports: bigint;
}

export interface DistributionResult {
  totalDistributedLamports: bigint;
  batches: DistributionBatchResult[];
  allocations: SplitAllocation[];
}

// ─────────────────────── Depósitos (provedor interno) ───────────────────────

/**
 * Trilhos de depósito aceitos.
 *
 * `USDC` é o único totalmente automático: o cliente manda a stablecoin para o
 * vault e a chegada é detectada on-chain. Os demais são fiat em conta do
 * operador — a confirmação é humana (o extrato bancário não tem webhook), e o
 * USDC que lastreia a ordem sai do float do próprio vault.
 */
export const DepositMethod = {
  USDC: 'USDC',
  CARD: 'CARD',
  /** Pix com QR pelo Mercado Pago: automático, cai na hora. */
  PIXQR: 'PIXQR',
  PIX: 'PIX',
  SEPA: 'SEPA',
  MBWAY: 'MBWAY',
  REVOLUT: 'REVOLUT',
} as const;

export type DepositMethod = (typeof DepositMethod)[keyof typeof DepositMethod];

export const DEPOSIT_METHODS: readonly DepositMethod[] = [
  DepositMethod.USDC,
  DepositMethod.CARD,
  DepositMethod.PIXQR,
  DepositMethod.PIX,
  DepositMethod.SEPA,
  DepositMethod.MBWAY,
  DepositMethod.REVOLUT,
];

/**
 * Trilhos que confirmam sem humano: `USDC` pela chain, `CARD` pelo PSP
 * (webhook + consulta de status). O resto é fiat em conta, e extrato bancário
 * não tem webhook — confirmação manual no painel.
 */
export function isAutoConfirmable(method: DepositMethod): boolean {
  return (
    method === DepositMethod.USDC ||
    method === DepositMethod.CARD ||
    method === DepositMethod.PIXQR
  );
}

export const DepositIntentStatus = {
  /** Criada; esperando o dinheiro. */
  AWAITING_PAYMENT: 'AWAITING_PAYMENT',
  /** Pagamento reconhecido: virou `Order` e a pipeline assumiu. */
  CONFIRMED: 'CONFIRMED',
  /** Passou do TTL sem pagamento. Não é erro. */
  EXPIRED: 'EXPIRED',
  /** Cancelada no painel. */
  CANCELLED: 'CANCELLED',
} as const;

export type DepositIntentStatus =
  (typeof DepositIntentStatus)[keyof typeof DepositIntentStatus];

/**
 * O que o checkout público pode ver. Deliberadamente sem `clientIp`, sem
 * `note` e sem nada do vault além do endereço de depósito — a página é
 * acessível por quem tiver a referência.
 */
export interface DepositIntentPublicView {
  reference: string;
  method: DepositMethod;
  fiatCurrency: FiatCurrency;
  fiatAmount: string;
  customerWallet: string;
  status: DepositIntentStatus;
  /** Valor a pagar no trilho escolhido, já formatado para exibição. */
  amountToPay: string;
  /** Instruções do trilho (chave Pix, IBAN, endereço do vault...). */
  instructions: DepositInstructionView;
  quotedFeeBps: number | null;
  quotedCustomerSol: string | null;
  /** Carteira que vai receber o SOL, e de quem é a chave dela. */
  wallet: {
    address: string;
    /** true = gerada pelo gateway, que guarda a chave cifrada. */
    generated: boolean;
  };
  /** Para onde mandar o cliente pagar no cartão. Null nos outros trilhos. */
  checkoutUrl: string | null;
  /** Dados do Pix com QR. Null fora desse trilho. */
  pix: {
    /** Payload copia e cola. */
    copyPaste: string;
    /** PNG em base64, pronto para um <img src="data:image/png;base64,…">. */
    qrBase64: string | null;
    expiresAt: string | null;
  } | null;
  expiresAt: string;
  createdAt: string;
  /** Preenchidos depois da confirmação: o rastro on-chain do cliente. */
  order: {
    id: string;
    status: OrderStatus;
    customerSol: number | null;
    swapSignature: string | null;
    payoutSignature: string | null;
    lastError: string | null;
  } | null;
}

/** Como pagar. Os campos vêm de `DEPOSIT_INSTRUCTIONS_JSON` (ou do vault). */
export interface DepositInstructionView {
  method: DepositMethod;
  label: string;
  /** Chave Pix / IBAN / número MB Way / endereço Solana do vault. */
  payTo: string;
  /** Titular da conta, quando o trilho mostra isso. */
  holder?: string;
  /** Linhas livres de instrução, exibidas na ordem. */
  lines: string[];
  /** true quando o pagamento é detectado sozinho. */
  autoConfirm: boolean;
  /** true quando o pagamento acontece fora daqui (página do PSP). */
  redirect?: boolean;
}

// ─────────────────────────── Settings (admin) ───────────────────────────

export interface GatewaySettingsView {
  distributionEnabled: boolean;
  distributionHour: number;
  distributionMinute: number;
  distributionTimezone: string;
  minProfitLamports: string;
  marginBps: number;
  minFeeBps: number;
  maxFeeBps: number;
  fallbackProviderCostBps: number;
  /** Quanto do valor pago fica em fiat, em bps (3000 = 30%). */
  fiatRetainedBps: number;
  /** Câmbio do operador para depósitos: USDC por 1 unidade de cada moeda. */
  depositRates: Record<string, number>;
  /** Próximo disparo calculado, em ISO UTC. */
  nextRunAt: string;
  updatedAt: string;
}

// ─────────────────────────── Erros ───────────────────────────

/**
 * Erro de domínio com semântica de retry: `retryable=false` manda a ordem
 * direto para FAILED em vez de queimar tentativas.
 */
export class GatewayError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean = true,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}
