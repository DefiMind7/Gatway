import 'dotenv/config';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { z } from 'zod';

/**
 * Carrega e valida TODO o ambiente uma única vez, no boot.
 * Se algo estiver errado o processo morre aqui — nunca em runtime, no meio de
 * uma ordem já paga pelo cliente.
 *
 * Nota: o split e os parâmetros de taxa/horário vivem no BANCO (editáveis pelo
 * admin). `RECIPIENTS_JSON` aqui é apenas o seed da primeira subida.
 */

const BPS_TOTAL = 10_000;

const recipientSchema = z.object({
  label: z.string().min(1).optional(),
  address: z.string().min(32).max(44),
  bps: z.number().int().positive().max(BPS_TOTAL),
});

const recipientsSchema = z
  .array(recipientSchema)
  .min(1, 'RECIPIENTS_JSON precisa de ao menos 1 destinatário')
  .superRefine((list, ctx) => {
    const sum = list.reduce((acc, r) => acc + r.bps, 0);
    if (sum !== BPS_TOTAL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `a soma dos bps precisa ser exatamente ${BPS_TOTAL} (100%), recebido ${sum}`,
      });
    }
    const seen = new Set<string>();
    list.forEach((r, i) => {
      try {
        new PublicKey(r.address);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, 'address'],
          message: `"${r.address}" não é uma public key Solana válida`,
        });
      }
      if (seen.has(r.address)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, 'address'],
          message: `endereço duplicado: ${r.address}`,
        });
      }
      seen.add(r.address);
    });
  });

/** Aceita base58 (Phantom) ou array JSON de 64 bytes (solana-keygen). */
function parseSecretKey(raw: string): Uint8Array {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || parsed.some((n) => typeof n !== 'number')) {
      throw new Error('VAULT_PRIVATE_KEY: array JSON inválido');
    }
    return Uint8Array.from(parsed as number[]);
  }
  return bs58.decode(trimmed);
}

const numeric = (fallback: number, opts: { min?: number; max?: number } = {}) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : Number(v)))
    .pipe(z.number().int().min(opts.min ?? 0).max(opts.max ?? Number.MAX_SAFE_INTEGER));

const boolish = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : /^(1|true|yes|on)$/i.test(v)));

/**
 * Instruções de pagamento por trilho, vindas de `DEPOSIT_INSTRUCTIONS_JSON`.
 *
 * Ficam em env (e não no banco) porque são dados do OPERADOR, não do produto:
 * chave Pix, IBAN, titular. Trocar de conta é um redeploy, não uma migração.
 */
const instructionSchema = z.object({
  label: z.string().min(1).optional(),
  /** Chave Pix / IBAN / número MB Way. Para USDC, default = endereço do vault. */
  payTo: z.string().min(1).optional(),
  holder: z.string().min(1).optional(),
  lines: z.array(z.string()).optional(),
});

const instructionsSchema = z.record(z.string(), instructionSchema);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: numeric(3000, { min: 1, max: 65_535 }),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  RPC_ENDPOINT: z.string().url(),
  RPC_SEND_ENDPOINT: z.string().url().optional().or(z.literal('')),

  VAULT_PRIVATE_KEY: z.string().min(1, 'VAULT_PRIVATE_KEY é obrigatória'),

  FIAT_PROVIDER: z.enum(['spherepay', 'moonpay']).default('spherepay'),
  FIAT_PROVIDER_SECRET: z.string().min(8, 'FIAT_PROVIDER_SECRET é obrigatória'),
  WEBHOOK_TOLERANCE_SECONDS: numeric(300, { min: 0 }),

  /** Protege /admin/*. Sem isto o painel não sobe. */
  ADMIN_API_KEY: z.string().min(16, 'ADMIN_API_KEY precisa de ao menos 16 caracteres'),

  /**
   * Segredo do cron externo (Vercel Cron manda `Authorization: Bearer`).
   * Só necessário onde o agendador in-process não funciona.
   */
  CRON_SECRET: z.string().min(16).optional(),

  /**
   * Libera a pipeline que move dinheiro (swap + liquidação).
   * Default: ligada em host persistente, DESLIGADA em serverless — ver
   * `isServerless` abaixo. Só force para `true` em serverless depois de trocar
   * os locks in-process por lock no banco.
   */
  ALLOW_PIPELINE: z.string().optional(),

  RECIPIENTS_JSON: z.string().min(2, 'RECIPIENTS_JSON é obrigatória (seed inicial)'),

  // ── Provedor interno de depósitos (ver deposit.service.ts) ──
  /** Kill switch do checkout público `/pay`. */
  DEPOSIT_ENABLED: boolish(true),
  /** Trilhos oferecidos, CSV. Ex.: "USDC,PIX,MBWAY". */
  DEPOSIT_METHODS: z.string().default('USDC'),
  /** Chave Pix, IBAN, titular... por trilho. Ver `instructionsSchema`. */
  DEPOSIT_INSTRUCTIONS_JSON: z.string().default('{}'),
  /**
   * Faixa aceita por depósito, em unidades da moeda escolhida.
   * O teto é o limite de exposição do teste: cada ordem consome USDC do float
   * do vault, e `MAX_ORDER_INPUT_RAW` continua valendo como trava final.
   */
  DEPOSIT_MIN_AMOUNT: numeric(5, { min: 1 }),
  DEPOSIT_MAX_AMOUNT: numeric(500, { min: 1 }),
  /** Validade da intenção. Depois disso o preço mostrado não vale mais. */
  DEPOSIT_INTENT_TTL_MINUTES: numeric(45, { min: 5, max: 1_440 }),
  /** Detecção on-chain de depósitos USDC (o único trilho automático). */
  DEPOSIT_AUTOCONFIRM: boolish(true),
  /** Quantas assinaturas recentes da ATA do vault a varredura inspeciona. */
  DEPOSIT_SCAN_SIGNATURES: numeric(30, { min: 1, max: 200 }),
  /** Intenções por IP por hora — freio de abuso no endpoint público. */
  DEPOSIT_MAX_INTENTS_PER_HOUR: numeric(20, { min: 1 }),
  /**
   * Recusa o depósito quando o vault não tem USDC para lastrear a ordem.
   *
   * Deixe ligado. Desligar significa aceitar dinheiro de cliente sem ter como
   * entregar o SOL — o cliente paga e a ordem trava até alguém fundear o vault.
   */
  DEPOSIT_REQUIRE_FLOAT: boolish(true),

  // ── Carteiras geradas para o cliente (custódia) ──
  /**
   * Liga a geração de carteira no checkout. Com isto o cliente não precisa ter
   * carteira nenhuma — e o operador passa a guardar chaves de terceiros.
   */
  WALLET_GENERATION: boolish(true),
  /**
   * Chave mestra que cifra as chaves privadas dos clientes (AES-256-GCM).
   * Aceita 32 bytes em hex, 32 bytes em base64, ou uma frase longa.
   *
   * **Perder isto é perder o dinheiro dos clientes.** Guarde fora do banco e
   * fora do repositório, com backup.
   */
  WALLET_ENCRYPTION_KEY: z.string().optional(),

  // ── Mercado Pago (trilho CARD) ──
  /**
   * URL pública desta aplicação. O PSP precisa dela para o retorno do cliente
   * e para o webhook. Em localhost o webhook não chega — e é por isso que o
   * status também é consultado no poll da página (ver `mercadopago.service`).
   */
  PUBLIC_BASE_URL: z.string().url().optional().or(z.literal('')),
  /** `TEST-...` na sandbox, `APP_USR-...` em produção. */
  MERCADOPAGO_ACCESS_TOKEN: z.string().optional(),
  /**
   * Public Key da mesma aplicação. Vai para o NAVEGADOR de propósito: é ela
   * que autoriza o SDK do MP a tokenizar o cartão dentro da nossa página.
   * Não é segredo — o segredo é o access token, que nunca sai do servidor.
   */
  MERCADOPAGO_PUBLIC_KEY: z.string().optional(),
  /** Segredo da assinatura do webhook (painel do MP → Webhooks). */
  MERCADOPAGO_WEBHOOK_SECRET: z.string().optional(),
  /** Usa `sandbox_init_point` em vez do link de produção. */
  MERCADOPAGO_SANDBOX: boolish(true),
  MERCADOPAGO_API_BASE: z.string().url().default('https://api.mercadopago.com'),
  /**
   * País da conta do Mercado Pago (o `site_id` da API).
   *
   * Define a moeda que a conta consegue processar e quais BINs de cartão ela
   * reconhece. Uma conta MLB (Brasil) cobra em BRL e não encontra meio de
   * pagamento para um cartão europeu — é o erro `no_payment_method_for_provided_bin`.
   */
  MERCADOPAGO_SITE: z.enum(['MLB', 'MLA', 'MLM', 'MLC', 'MCO', 'MPE', 'MLU']).default('MLB'),

  // `quote-api.jup.ag/v6` foi retirado do ar (o host não resolve mais).
  // `lite-api.jup.ag/swap/v1` é o tier público atual e serve exatamente o
  // mesmo contrato do v6 (/quote e /swap, mesmos campos) — verificado.
  JUPITER_API_BASE: z.string().url().default('https://lite-api.jup.ag/swap/v1'),
  INPUT_MINT: z.string().min(32),
  INPUT_MINT_DECIMALS: numeric(6, { min: 0, max: 18 }),
  SLIPPAGE_BPS: numeric(50, { min: 1, max: BPS_TOTAL }),
  PRIORITY_FEE_MICRO_LAMPORTS: numeric(200_000, { min: 0 }),
  /** Aborta o swap se o price impact passar disto (proteção contra pool raso). */
  MAX_PRICE_IMPACT_BPS: numeric(300, { min: 1, max: BPS_TOTAL }),

  /**
   * Custo de rede repassado ao cliente, em lamports.
   *
   * Cobre a taxa do swap (com prioridade) mais a da transferência de
   * liquidação. É descontado do SOL dele e fica no vault como reembolso — por
   * isso o vault não drena com o volume.
   *
   * Default 0,0002 SOL: folgado para as duas transações com a prioridade
   * configurada. Subir demais é cobrar do cliente o que não foi gasto.
   */
  NETWORK_COST_LAMPORTS: numeric(200_000, { min: 0 }),
  /**
   * Carteira que recebe as taxas de gás acumuladas.
   *
   * O custo cobrado do cliente fica no vault (é ele que paga as taxas das
   * próximas ordens); o que passa da reserva pode ser varrido para cá.
   * Vazio = nada é varrido, tudo permanece no vault.
   */
  GAS_FEE_WALLET: z.string().optional(),

  FEE_RESERVE_LAMPORTS: numeric(10_000_000, { min: 0 }),
  MIN_TRANSFER_LAMPORTS: numeric(890_880, { min: 1 }),
  MAX_TRANSFERS_PER_TX: numeric(18, { min: 1, max: 24 }),
  MAX_ATTEMPTS: numeric(3, { min: 1, max: 10 }),
  DEPOSIT_WAIT_TIMEOUT_MS: numeric(180_000, { min: 0 }),
  /** Teto de trabalho síncrono por invocação serverless (< maxDuration). */
  SERVERLESS_BUDGET_MS: numeric(45_000, { min: 1_000 }),
  /** Teto por ordem — limita o dano de um evento forjado ou de um bug. */
  MAX_ORDER_INPUT_RAW: numeric(50_000_000_000, { min: 1 }),

  // ── Agregador de taxas dos on-ramps ──
  FEE_CACHE_TTL_MS: numeric(300_000, { min: 0 }),
  MOONPAY_ENABLED: boolish(false),
  MOONPAY_API_KEY: z.string().optional(),
  MOONPAY_API_BASE: z.string().url().default('https://api.moonpay.com'),
  TRANSAK_ENABLED: boolish(false),
  TRANSAK_API_KEY: z.string().optional(),
  TRANSAK_API_BASE: z.string().url().default('https://api.transak.com'),
  RAMP_ENABLED: boolish(false),
  RAMP_API_KEY: z.string().optional(),
  RAMP_API_BASE: z.string().url().default('https://api.ramp.network'),
  SPHEREPAY_ENABLED: boolish(false),
  SPHEREPAY_API_KEY: z.string().optional(),
  SPHEREPAY_API_BASE: z.string().url().default('https://api.spherepay.co'),
});

/**
 * Erro de configuração com a lista completa do que está errado.
 *
 * Este módulo NÃO chama `process.exit()`. Matar o processo durante o `import`
 * é o pior comportamento possível fora de um servidor de longa duração: numa
 * função serverless o resultado é um `FUNCTION_INVOCATION_FAILED` opaco, sem
 * nenhuma pista de qual variável falta. Quem importa decide o que fazer —
 * `server.ts` encerra com a lista impressa, o handler serverless responde 503
 * com ela em JSON.
 */
export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`configuração inválida:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  throw new ConfigError(
    parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    ),
  );
}
const env = parsed.data;

let vaultKeypair: Keypair;
try {
  vaultKeypair = Keypair.fromSecretKey(parseSecretKey(env.VAULT_PRIVATE_KEY));
} catch (err) {
  throw new ConfigError([
    `VAULT_PRIVATE_KEY inválida (esperado base58 ou array de 64 bytes): ${
      err instanceof Error ? err.message : String(err)
    }`,
  ]);
}

const recipientsSeed = (() => {
  let json: unknown;
  try {
    json = JSON.parse(env.RECIPIENTS_JSON);
  } catch {
    throw new ConfigError(['RECIPIENTS_JSON não é um JSON válido']);
  }
  const result = recipientsSchema.safeParse(json);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `RECIPIENTS_JSON[${issue.path.join('.')}]: ${issue.message}`),
    );
  }
  return result.data;
})();

const depositInstructions = (() => {
  let json: unknown;
  try {
    json = JSON.parse(env.DEPOSIT_INSTRUCTIONS_JSON);
  } catch {
    throw new ConfigError(['DEPOSIT_INSTRUCTIONS_JSON não é um JSON válido']);
  }
  const result = instructionsSchema.safeParse(json);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map(
        (issue) => `DEPOSIT_INSTRUCTIONS_JSON[${issue.path.join('.')}]: ${issue.message}`,
      ),
    );
  }
  return result.data;
})();

const depositMethods = (() => {
  const known = ['USDC', 'CARD', 'PIXQR', 'PIX', 'SEPA', 'MBWAY', 'REVOLUT'] as const;
  const list = env.DEPOSIT_METHODS.split(',')
    .map((m) => m.trim().toUpperCase())
    .filter((m) => m.length > 0);

  const unknown = list.filter((m) => !known.includes(m as (typeof known)[number]));
  if (unknown.length > 0) {
    throw new ConfigError([
      `DEPOSIT_METHODS: trilho desconhecido ${unknown.join(', ')} (aceitos: ${known.join(', ')})`,
    ]);
  }
  if (list.length === 0) {
    throw new ConfigError(['DEPOSIT_METHODS: precisa de ao menos um trilho']);
  }

  /**
   * Um trilho fiat sem `payTo` é uma página de checkout que pede dinheiro e
   * não diz para onde mandar. Falha no boot, não no cliente.
   */
  const missing = list.filter(
    (m) => m !== 'USDC' && m !== 'CARD' && m !== 'PIXQR' && !depositInstructions[m]?.payTo,
  );
  if (missing.length > 0) {
    throw new ConfigError(
      missing.map(
        (m) =>
          `DEPOSIT_INSTRUCTIONS_JSON: falta "${m}".payTo (chave Pix / IBAN / número) — ` +
          `o trilho está em DEPOSIT_METHODS`,
      ),
    );
  }

  // Trilho do PSP sem credencial é um botão que leva a lugar nenhum.
  if ((list.includes('CARD') || list.includes('PIXQR')) && !env.MERCADOPAGO_ACCESS_TOKEN) {
    throw new ConfigError([
      'MERCADOPAGO_ACCESS_TOKEN é obrigatória com CARD ou PIXQR em DEPOSIT_METHODS ' +
        '(painel do Mercado Pago → Suas integrações → Credenciais)',
    ]);
  }

  return [...new Set(list)] as Array<(typeof known)[number]>;
})();

/**
 * Geração de carteira sem chave de cifra seria guardar chave privada de
 * cliente em claro no banco. Falha no boot, não em runtime.
 */
const walletKey = env.WALLET_ENCRYPTION_KEY ?? '';
if (env.WALLET_GENERATION && walletKey.length < 32) {
  throw new ConfigError([
    'WALLET_ENCRYPTION_KEY é obrigatória com WALLET_GENERATION=true e precisa de ' +
      'ao menos 32 caracteres (gere com: npm run walletkey). Sem ela, as chaves ' +
      'privadas dos clientes ficariam em claro no banco.',
  ]);
}

/** Valida a carteira de gás no boot: endereço errado só apareceria na varredura. */
const gasFeeWallet = (() => {
  const raw = (env.GAS_FEE_WALLET ?? '').trim();
  if (raw === '') return '';
  try {
    new PublicKey(raw);
  } catch {
    throw new ConfigError([`GAS_FEE_WALLET não é uma public key Solana válida: "${raw}"`]);
  }
  return raw;
})();

if (env.DEPOSIT_MIN_AMOUNT > env.DEPOSIT_MAX_AMOUNT) {
  throw new ConfigError([
    `DEPOSIT_MIN_AMOUNT (${env.DEPOSIT_MIN_AMOUNT}) não pode ser maior que ` +
      `DEPOSIT_MAX_AMOUNT (${env.DEPOSIT_MAX_AMOUNT})`,
  ]);
}

/**
 * Detecção de ambiente serverless.
 *
 * Importa porque três garantias do sistema dependem de um processo único e de
 * longa duração: o agendador (`setTimeout`), o mutex de swap e o guard de
 * concorrência por ordem. Nenhuma delas sobrevive a N instâncias efêmeras.
 */
const isServerless =
  process.env.VERCEL === '1' ||
  process.env.AWS_LAMBDA_FUNCTION_NAME !== undefined ||
  process.env.FUNCTIONS_WORKER_RUNTIME !== undefined;

/**
 * Moeda de cada país do Mercado Pago.
 *
 * A conta só processa a moeda do próprio site: uma conta brasileira cobra em
 * BRL e nada mais. Oferecer outra no checkout é vender algo que o PSP vai
 * recusar depois de o cliente digitar o cartão.
 */
const MP_SITE_CURRENCY = {
  MLB: 'BRL',
  MLA: 'ARS',
  MLM: 'MXN',
  MLC: 'CLP',
  MCO: 'COP',
  MPE: 'PEN',
  MLU: 'UYU',
} as const;

/** Mint nativo do SOL empacotado — output do swap no Jupiter. */
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const LAMPORTS_PER_SOL = 1_000_000_000;
export const TOTAL_BPS = BPS_TOTAL;

/**
 * A pipeline é liberada em qualquer runtime — inclusive serverless — desde que
 * os locks sejam distribuídos, o que passou a ser o caso: `lock.service.ts` usa
 * a tabela `Lock` no banco, não estruturas em memória. `ALLOW_PIPELINE=false`
 * segue disponível como kill switch operacional.
 */
const allowPipeline =
  env.ALLOW_PIPELINE === undefined || env.ALLOW_PIPELINE === ''
    ? true
    : /^(1|true|yes|on)$/i.test(env.ALLOW_PIPELINE);

/**
 * Orçamento de tempo para trabalho síncrono numa invocação serverless.
 *
 * Em serverless não existe "background": depois de responder, a função pode ser
 * congelada ou morta, então `setImmediate` não é garantia de nada. A pipeline
 * roda ANTES da resposta, com este teto para não estourar o `maxDuration` da
 * plataforma (60s no vercel.json) e virar timeout.
 */
const serverlessBudgetMs = env.SERVERLESS_BUDGET_MS;

export const config = {
  env: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
  isServerless,
  port: env.PORT,
  logLevel: env.LOG_LEVEL,

  solana: {
    rpcEndpoint: env.RPC_ENDPOINT,
    sendEndpoint: env.RPC_SEND_ENDPOINT || env.RPC_ENDPOINT,
    vaultKeypair,
    vaultPublicKey: vaultKeypair.publicKey,
  },

  fiat: {
    provider: env.FIAT_PROVIDER,
    webhookSecret: env.FIAT_PROVIDER_SECRET,
    toleranceSeconds: env.WEBHOOK_TOLERANCE_SECONDS,
  },

  admin: {
    apiKey: env.ADMIN_API_KEY,
    ...(env.CRON_SECRET !== undefined ? { cronSecret: env.CRON_SECRET } : { cronSecret: '' }),
  },

  swap: {
    jupiterBase: env.JUPITER_API_BASE,
    inputMint: env.INPUT_MINT,
    inputMintDecimals: env.INPUT_MINT_DECIMALS,
    outputMint: SOL_MINT,
    slippageBps: env.SLIPPAGE_BPS,
    priorityFeeMicroLamports: env.PRIORITY_FEE_MICRO_LAMPORTS,
    maxPriceImpactBps: env.MAX_PRICE_IMPACT_BPS,
  },

  distribution: {
    /** Seed only: a fonte de verdade é a tabela `Recipient`. */
    recipientsSeed: recipientsSeed.map((r, i) => ({
      label: r.label ?? `recipient-${i + 1}`,
      address: r.address,
      bps: r.bps,
    })),
    feeReserveLamports: BigInt(env.FEE_RESERVE_LAMPORTS),
    minTransferLamports: BigInt(env.MIN_TRANSFER_LAMPORTS),
    maxTransfersPerTx: env.MAX_TRANSFERS_PER_TX,
  },

  runtime: {
    maxAttempts: env.MAX_ATTEMPTS,
    depositWaitTimeoutMs: env.DEPOSIT_WAIT_TIMEOUT_MS,
    maxOrderInputRaw: BigInt(env.MAX_ORDER_INPUT_RAW),
    networkCostLamports: BigInt(env.NETWORK_COST_LAMPORTS),
    gasFeeWallet: gasFeeWallet,
    /** Kill switch: quando false, nenhuma etapa que move dinheiro executa. */
    allowPipeline,
    serverlessBudgetMs,
    /**
     * Espera pelo depósito. Em serverless é limitada pelo orçamento da
     * invocação — o resto fica para o próximo tick do cron.
     */
    depositWaitBudgetMs: isServerless
      ? Math.min(env.DEPOSIT_WAIT_TIMEOUT_MS, Math.floor(serverlessBudgetMs * 0.5))
      : env.DEPOSIT_WAIT_TIMEOUT_MS,
  },

  /**
   * Provedor interno de depósitos: o caminho para receber dinheiro sem
   * onboarding de on-ramp. Ver `deposit.service.ts` e README.
   */
  deposit: {
    enabled: env.DEPOSIT_ENABLED,
    methods: depositMethods,
    instructions: depositInstructions,
    minAmount: env.DEPOSIT_MIN_AMOUNT,
    maxAmount: env.DEPOSIT_MAX_AMOUNT,
    ttlMs: env.DEPOSIT_INTENT_TTL_MINUTES * 60_000,
    autoConfirm: env.DEPOSIT_AUTOCONFIRM,
    scanSignatures: env.DEPOSIT_SCAN_SIGNATURES,
    maxIntentsPerHour: env.DEPOSIT_MAX_INTENTS_PER_HOUR,
    requireFloat: env.DEPOSIT_REQUIRE_FLOAT,
  },

  /**
   * Carteiras custodiadas. Ver `wallet.service.ts` — e a advertência sobre
   * custódia no README antes de ligar isto em produção.
   */
  wallet: {
    enabled: env.WALLET_GENERATION,
    encryptionKey: walletKey,
  },

  /** Trilho de cartão. Vazio = desligado (e `CARD` não sobe em DEPOSIT_METHODS). */
  mercadopago: {
    accessToken: env.MERCADOPAGO_ACCESS_TOKEN ?? '',
    publicKey: env.MERCADOPAGO_PUBLIC_KEY ?? '',
    webhookSecret: env.MERCADOPAGO_WEBHOOK_SECRET ?? '',
    sandbox: env.MERCADOPAGO_SANDBOX,
    base: env.MERCADOPAGO_API_BASE,
    publicBaseUrl: env.PUBLIC_BASE_URL ?? '',
    site: env.MERCADOPAGO_SITE,
    /** Moeda que a conta processa. Cobrar em outra é recusa garantida. */
    currency: MP_SITE_CURRENCY[env.MERCADOPAGO_SITE],
  },

  feeProviders: {
    cacheTtlMs: env.FEE_CACHE_TTL_MS,
    moonpay: {
      enabled: env.MOONPAY_ENABLED,
      apiKey: env.MOONPAY_API_KEY ?? '',
      base: env.MOONPAY_API_BASE,
    },
    transak: {
      enabled: env.TRANSAK_ENABLED,
      apiKey: env.TRANSAK_API_KEY ?? '',
      base: env.TRANSAK_API_BASE,
    },
    ramp: {
      enabled: env.RAMP_ENABLED,
      apiKey: env.RAMP_API_KEY ?? '',
      base: env.RAMP_API_BASE,
    },
    spherepay: {
      enabled: env.SPHEREPAY_ENABLED,
      apiKey: env.SPHEREPAY_API_KEY ?? '',
      base: env.SPHEREPAY_API_BASE,
    },
  },
} as const;

export type AppConfig = typeof config;
