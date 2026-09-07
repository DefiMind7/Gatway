import crypto from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { config, LAMPORTS_PER_SOL } from '../config';
import { prisma } from '../database/client';
import { GatewayError, SUPPORTED_CURRENCIES, type FiatCurrency as Fiat } from '../types';
import { logger } from '../utils/logger';
import { jsonSafe } from '../utils/serialize';
import { previewSplit } from '../services/distribution.service';
import {
  cancelIntent,
  confirmIntent,
  expireStaleIntents,
  getCheckoutOptions,
  getFloatStatus,
  getRetainedFiatTotals,
  listIntents,
} from '../services/deposit.service';
import { scanOnchainDeposits } from '../services/deposit-watch.service';
import { getGasSweepStatus, sweepGasFees } from '../services/gas.service';
import { findOrphanPayments, reconcilePspPayments } from '../services/reconcile.service';
import {
  approveApplication,
  countPending,
  listApplications,
  rejectApplication,
} from '../services/application.service';
import {
  createMerchant,
  listMerchants,
  retryMerchantNotifications,
  rotateApiKey,
  setMerchantActive,
} from '../services/merchant.service';
import {
  reopenOrder,
  settleManually,
  undoManualSettlement,
} from '../services/manual-settle.service';
import { adapterStatus, compareProviderFees, recentFeeSnapshots, resolveEffectiveFee } from '../services/fee.service';
import { listLocks, pruneExpiredLocks } from '../services/lock.service';
import {
  getAccruedProfit,
  getOrderStats,
  getPendingDelivery,
  retryPendingOrders,
} from '../services/order.service';
import {
  hasPartialRuns,
  listRuns,
  resumeIncompleteRuns,
  runProfitDistribution,
} from '../services/payout.service';
import { getNextRunAt, scheduleNextRun } from '../services/scheduler.service';
import {
  getRecipients,
  getSettingsView,
  replaceRecipients,
  updateSettings,
  type RecipientInput,
  type SettingsPatch,
} from '../services/settings.service';
import { getBalance, getTokenBalanceRaw, lamportsToSol } from '../services/solana.service';
import { ADMIN_PAGE_HTML } from './admin.page';
import { ah } from '../utils/async-route';

/**
 * Painel administrativo.
 *
 * Autenticação por `ADMIN_API_KEY` (Bearer ou `x-admin-key`), comparada em
 * tempo constante. É proteção de chave estática, adequada para uso interno —
 * não substitui login por usuário com auditoria por pessoa, que é o que uma
 * operação com múltiplos sócios eventualmente vai querer.
 */

const router: Router = Router();
const log = logger.child({ scope: 'admin' });

// ─────────────────────────── Autenticação ───────────────────────────

/** Contador simples de falhas por IP, para não deixar a chave ser adivinhada. */
const failures = new Map<string, { count: number; first: number }>();
const LOCKOUT_WINDOW_MS = 10 * 60 * 1_000;
const MAX_FAILURES = 10;

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function extractKey(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7).trim();
  const direct = req.headers['x-admin-key'];
  if (typeof direct === 'string' && direct.length > 0) return direct;
  return null;
}

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip ?? 'unknown';
  const record = failures.get(ip);
  if (record && Date.now() - record.first < LOCKOUT_WINDOW_MS && record.count >= MAX_FAILURES) {
    /**
     * Diz quanto falta. "Tente novamente mais tarde", sem prazo, é
     * indistinguível de "quebrou" — e quem mais vê essa tela é o próprio
     * operador, depois de errar a senha algumas vezes ou de trocá-la.
     */
    const restaSegundos = Math.ceil((LOCKOUT_WINDOW_MS - (Date.now() - record.first)) / 1_000);
    const minutos = Math.ceil(restaSegundos / 60);

    res.status(429).json({
      error: 'too_many_attempts',
      message:
        `muitas tentativas incorretas deste IP — espere ${minutos} minuto(s) ` +
        '(ou reinicie o servidor, que zera a contagem)',
      retryAfterSeconds: restaSegundos,
    });
    return;
  }

  const provided = extractKey(req);
  if (provided === null || !constantTimeEquals(provided, config.admin.apiKey)) {
    const next_ = record && Date.now() - record.first < LOCKOUT_WINDOW_MS
      ? { count: record.count + 1, first: record.first }
      : { count: 1, first: Date.now() };
    failures.set(ip, next_);

    // Diagnóstico sem vazar a chave: só o comprimento, e só fora de produção.
    // Um campo de senha invisível com autofill do navegador é indistinguível de
    // "chave errada" sem esta dica.
    const hint =
      config.isProduction
        ? undefined
        : provided === null
          ? 'nenhum header de chave recebido (esperado x-admin-key ou Authorization: Bearer)'
          : `comprimento recebido ${provided.length}, esperado ${config.admin.apiKey.length}` +
            (provided.length !== config.admin.apiKey.length
              ? ' — o campo provavelmente foi autopreenchido pelo navegador'
              : ' — comprimento bate, conteúdo não');

    log.warn(
      { ip, attempts: next_.count, receivedLength: provided?.length ?? 0 },
      'acesso ao admin rejeitado',
    );
    res.status(401).json({ error: 'unauthorized', ...(hint ? { message: hint } : {}) });
    return;
  }

  failures.delete(ip);
  next();
}

// ─────────────────────────── Página ───────────────────────────

/** A página em si não expõe dado nenhum: pede a chave e chama a API. */
router.get('/', (_req: Request, res: Response) => {
  res.type('html').send(ADMIN_PAGE_HTML);
});

router.use('/api', requireAdmin);

// ─────────────────────────── Visão geral ───────────────────────────

router.get('/api/overview', ah(async (_req: Request, res: Response) => {
  const [stats, profit, settings, vaultLamports, partial, awaiting, awaitingActive, usdcFloat] =
    await Promise.all([
      getOrderStats(),
      getAccruedProfit(),
      getSettingsView(),
      getBalance().catch(() => null),
      hasPartialRuns(),
      prisma.depositIntent.count({ where: { status: 'AWAITING_PAYMENT' } }),
      prisma.depositIntent.count({
        where: { status: 'AWAITING_PAYMENT', expiresAt: { gt: new Date() } },
      }),
      getTokenBalanceRaw(config.swap.inputMint).catch(() => null),
    ]);

  const [retained, float, pending, gas, orphans, pedidosPendentes] = await Promise.all([
    getRetainedFiatTotals(),
    getFloatStatus(),
    getPendingDelivery(),
    getGasSweepStatus(),
    // Falha do PSP não pode derrubar a visão geral inteira.
    findOrphanPayments().catch(() => []),
    countPending(),
  ]);
  const decimals = config.swap.inputMintDecimals;

  res.json({
    orders: stats,
    profit: {
      accruedLamports: profit.lamports.toString(),
      accruedSol: Number(profit.lamports) / LAMPORTS_PER_SOL,
      orderCount: profit.orderCount,
    },
    vault: {
      address: config.solana.vaultPublicKey.toBase58(),
      sol: vaultLamports === null ? null : lamportsToSol(vaultLamports),
      feeReserveSol: lamportsToSol(config.distribution.feeReserveLamports),
    },
    schedule: {
      enabled: settings.distributionEnabled,
      localTime: `${String(settings.distributionHour).padStart(2, '0')}:${String(
        settings.distributionMinute,
      ).padStart(2, '0')}`,
      timezone: settings.distributionTimezone,
      nextRunAt: getNextRunAt()?.toISOString() ?? settings.nextRunAt,
      minProfitSol: Number(settings.minProfitLamports) / LAMPORTS_PER_SOL,
    },
    deposits: {
      awaiting,
      /** Só as que ainda podem ser pagas — o resto é histórico. */
      awaitingActive,
      checkoutUrl: '/pay',
      methods: config.deposit.methods,
      autoConfirm: config.deposit.autoConfirm,
      /**
       * Float de stablecoin no vault. É o que lastreia os trilhos fiat: sem
       * ele, uma confirmação manual gera ordem que fica em DEPOSIT_NOT_COVERED.
       */
      usdcFloat:
        usdcFloat === null
          ? null
          : Number(usdcFloat) / 10 ** config.swap.inputMintDecimals,
      /**
       * Receita retida em fiat — o dinheiro que ficou na conta do PSP/banco.
       * Não está na chain e não entra em `PayoutRun`: a divisão entre sócios
       * dessa parte é transferência bancária, feita por fora.
       */
      retainedFiat: retained,
      /**
       * Float livre: o que ainda dá para vender. Com `requireFloat` ligado,
       * é o teto real de quanto os clientes conseguem depositar agora.
       */
      floatAvailable: Number(float.availableRaw) / 10 ** decimals,
      floatCommitted: Number(float.committedRaw) / 10 ** decimals,
      requireFloat: config.deposit.requireFloat,
      /**
       * Clientes que já pagaram e ainda não receberam. No modelo de conversão
       * manual esta é a fila que o operador precisa zerar: `usdcNeeded` é
       * exatamente quanto comprar e mandar para o vault.
       */
      pendingDelivery: {
        count: pending.count,
        usdcNeeded: Number(pending.requiredRaw) / 10 ** decimals,
        oldestAt: pending.oldestAt,
        orders: pending.orders,
      },
    },
    gas: {
      wallet: gas.wallet,
      accruedSol: Number(gas.accruedLamports) / LAMPORTS_PER_SOL,
      sweepableSol: Number(gas.sweepableLamports) / LAMPORTS_PER_SOL,
      orderCount: gas.orderCount,
      limitedBy: gas.limitedBy,
    },
    /**
     * Dinheiro que entrou na conta do PSP e não bate com nenhuma ordem. É a
     * checagem que fecha o ciclo: todo pagamento aprovado ou virou ordem, ou
     * aparece aqui.
     */
    orphanPayments: orphans,
    /** Lojas esperando análise para receber chave de API. */
    pendingApplications: pedidosPendentes,
    warnings: {
      partialRuns: partial,
      vaultBelowReserve:
        vaultLamports !== null && vaultLamports < config.distribution.feeReserveLamports,
    },
    env: config.env,
  });
}));

// ─────────────────────────── Configurações ───────────────────────────

router.get('/api/settings', ah(async (_req: Request, res: Response) => {
  res.json(await getSettingsView());
}));

router.put('/api/settings', ah(async (req: Request, res: Response) => {
  const patch = req.body as SettingsPatch;
  await updateSettings(patch);
  // Horário pode ter mudado: reagenda imediatamente.
  await scheduleNextRun();
  res.json(await getSettingsView());
}));

// ─────────────────────────── Destinatários (split) ───────────────────────────

router.get('/api/recipients', ah(async (_req: Request, res: Response) => {
  const recipients = await getRecipients();
  let preview: unknown = null;
  try {
    preview = await previewSplit(BigInt(LAMPORTS_PER_SOL));
  } catch (err) {
    preview = { error: err instanceof Error ? err.message : String(err) };
  }
  res.json({
    recipients: recipients.map((r) => ({
      label: r.label,
      address: r.address,
      bps: r.bps,
      percent: `${(r.bps / 100).toFixed(2)}%`,
      active: r.active,
    })),
    totalBps: recipients.reduce((acc, r) => acc + r.bps, 0),
    splitPreviewFor1Sol: preview,
  });
}));

router.put('/api/recipients', ah(async (req: Request, res: Response) => {
  const body = req.body as { recipients?: RecipientInput[] };
  if (!body || !Array.isArray(body.recipients)) {
    throw new GatewayError('esperado { recipients: [...] }', 'INVALID_BODY', false);
  }
  const saved = await replaceRecipients(body.recipients);
  res.json({
    recipients: saved.map((r) => ({
      label: r.label,
      address: r.address,
      bps: r.bps,
      percent: `${(r.bps / 100).toFixed(2)}%`,
      active: r.active,
    })),
  });
}));

// ─────────────────────────── Taxas dos on-ramps ───────────────────────────

function parseCurrency(raw: unknown): Fiat {
  const value = String(raw ?? 'EUR').toUpperCase();
  if (!SUPPORTED_CURRENCIES.includes(value as Fiat)) {
    throw new GatewayError(
      `moeda não suportada: "${value}" (aceitas: ${SUPPORTED_CURRENCIES.join(', ')})`,
      'UNSUPPORTED_CURRENCY',
      false,
    );
  }
  return value as Fiat;
}

function parseAmount(raw: unknown): number {
  const value = Number(raw ?? 100);
  if (!Number.isFinite(value) || value <= 0) {
    throw new GatewayError('amount precisa ser um número positivo', 'INVALID_AMOUNT', false);
  }
  return value;
}

router.get('/api/fees', ah(async (req: Request, res: Response) => {
  const currency = parseCurrency(req.query.currency);
  const amount = parseAmount(req.query.amount);
  const refresh = req.query.refresh === '1' || req.query.refresh === 'true';

  const [comparison, fee] = await Promise.all([
    compareProviderFees(currency, amount, { skipCache: refresh }),
    resolveEffectiveFee(currency, amount),
  ]);

  res.json({
    comparison,
    effectiveFee: fee,
    adapters: adapterStatus(),
    note:
      'Adapters não verificados contra as APIs reais (sem chaves). Confirme o costBps ' +
      'contra o extrato do provedor antes de confiar em produção.',
  });
}));

router.get('/api/fees/history', ah(async (_req: Request, res: Response) => {
  res.json({ snapshots: await recentFeeSnapshots(60) });
}));

// ─────────────────────────── Distribuição ───────────────────────────

router.get('/api/runs', ah(async (_req: Request, res: Response) => {
  res.json({ runs: await listRuns(20) });
}));

/** Locks ativos — diagnóstico de concorrência ("por que a ordem não anda?"). */
router.get('/api/locks', ah(async (_req: Request, res: Response) => {
  res.json({ locks: await listLocks() });
}));

/**
 * Disparo por cron EXTERNO (Vercel Cron, GitHub Actions, cron do sistema).
 *
 * Autenticado por `CRON_SECRET`, não pela chave do admin — o cron não deve
 * carregar a credencial que edita o split. Vercel Cron manda
 * `Authorization: Bearer $CRON_SECRET` automaticamente.
 *
 * Fica FORA de `/api` (que exige a chave do admin) de propósito, e é montado
 * antes do middleware por isso.
 */
/** Valida o segredo do cron. Devolve a resposta de erro, ou null se ok. */
function checkCronAuth(req: Request, res: Response): Response | null {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const secret = config.admin.cronSecret;
  if (!secret) {
    return res.status(503).json({
      error: 'cron_not_configured',
      message: 'CRON_SECRET não definida — disparo por cron desabilitado',
    });
  }
  const header = req.headers.authorization;
  const provided = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!constantTimeEquals(provided, secret)) {
    log.warn({ ip: req.ip, path: req.path }, 'disparo de cron rejeitado');
    return res.status(401).json({ error: 'unauthorized' });
  }
  return null;
}

/**
 * Tick do cron — o "processo de fundo" de um runtime serverless.
 *
 * Num host persistente isto é feito por timers dentro do processo. Em
 * serverless não há processo entre requisições, então tudo que é periódico tem
 * de ser puxado de fora:
 *
 *  1. retoma execuções de distribuição interrompidas;
 *  2. retoma ordens que não terminaram (depósito que aterrou depois do
 *     orçamento da invocação do webhook, erro transitório);
 *  3. roda a distribuição de lucro, se houver o que distribuir;
 *  4. limpa locks expirados.
 *
 * Idempotente: pode ser chamado com qualquer frequência. Cada etapa é protegida
 * por lock no banco, então dois ticks sobrepostos não duplicam trabalho.
 */
router.all('/cron/tick', ah(async (req: Request, res: Response) => {
  const denied = checkCronAuth(req, res);
  if (denied) return denied;

  const startedAt = Date.now();
  const budget = config.runtime.serverlessBudgetMs;
  const steps: Record<string, unknown> = {};

  try {
    await resumeIncompleteRuns();
    steps.resumeIncompleteRuns = 'ok';
  } catch (err) {
    steps.resumeIncompleteRuns = err instanceof Error ? err.message : String(err);
  }

  // Depósitos antes das ordens: uma varredura que confirma um depósito agora
  // gera a ordem que o passo seguinte já processa, no mesmo tick.
  try {
    // Primeiro o PSP: é o caminho que não depende de webhook nem de navegador.
    steps.pspReconcile = await reconcilePspPayments();
  } catch (err) {
    steps.pspReconcile = err instanceof Error ? err.message : String(err);
  }

  try {
    steps.expiredIntents = await expireStaleIntents();
  } catch (err) {
    steps.expiredIntents = err instanceof Error ? err.message : String(err);
  }

  try {
    steps.depositScan = await scanOnchainDeposits();
  } catch (err) {
    steps.depositScan = err instanceof Error ? err.message : String(err);
  }

  try {
    const processed = await retryPendingOrders({ budgetMs: budget - (Date.now() - startedAt) });
    steps.retryPendingOrders = processed;
  } catch (err) {
    steps.retryPendingOrders = err instanceof Error ? err.message : String(err);
  }

  try {
    steps.distribution = await runProfitDistribution({ trigger: 'CRON' });
  } catch (err) {
    steps.distribution = err instanceof Error ? err.message : String(err);
  }

  try {
    steps.merchantNotifications = await retryMerchantNotifications();
  } catch (err) {
    steps.merchantNotifications = err instanceof Error ? err.message : String(err);
  }

  try {
    steps.prunedLocks = await pruneExpiredLocks();
  } catch (err) {
    steps.prunedLocks = err instanceof Error ? err.message : String(err);
  }

  return res.json({ ok: true, elapsedMs: Date.now() - startedAt, steps });
}));

/** Só a distribuição, sem a varredura de ordens. */
router.all('/cron/distribute', ah(async (req: Request, res: Response) => {
  const denied = checkCronAuth(req, res);
  if (denied) return denied;

  log.info('distribuição disparada por cron externo');
  const summary = await runProfitDistribution({ trigger: 'CRON' });
  return res.json(summary);
}));

router.post('/api/distribution/run-now', ah(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { ignoreMinimum?: boolean };
  log.warn({ ignoreMinimum: Boolean(body.ignoreMinimum) }, 'distribuição manual disparada pelo admin');
  const summary = await runProfitDistribution({
    trigger: 'MANUAL',
    ignoreMinimum: Boolean(body.ignoreMinimum),
  });
  res.json(summary);
}));

// ─────────────────────── Depósitos (provedor interno) ───────────────────────

/**
 * A fila do operador. É esta tela que faz o trilho manual funcionar: o
 * dinheiro cai no banco, o operador confere o extrato e confirma aqui.
 */
router.get('/api/deposits', ah(async (req: Request, res: Response) => {
  // `options` acompanha a fila porque o painel precisa saber a retenção
  // vigente para explicar os números da tabela.
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const limit = Number(req.query.limit ?? 30);

  const [intents, options, settings] = await Promise.all([
    listIntents({ ...(status ? { status } : {}), limit }),
    getCheckoutOptions(),
    getSettingsView(),
  ]);

  // A precificação vem daqui, e não do payload público — que deixou de
  // carregá-la de propósito.
  res.json({
    intents,
    options: {
      ...options,
      fiatRetainedBps: settings.fiatRetainedBps,
      depositRates: settings.depositRates,
    },
  });
}));

/**
 * Confirma um depósito.
 *
 * **É o clique que move dinheiro**: a partir daqui a pipeline compra SOL com
 * USDC do vault e envia para a carteira do cliente. Num trilho fiat, confirmar
 * sem o dinheiro ter caído é uma perda real — o gateway não tem como verificar
 * o extrato bancário do operador.
 */
router.post('/api/deposits/:reference/confirm', ah(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { note?: string; depositSignature?: string; force?: boolean };
  const reference = String(req.params.reference ?? '');

  log.warn({ reference, force: Boolean(body.force) }, 'confirmação manual de depósito');

  const result = await confirmIntent(reference, {
    confirmedBy: 'admin',
    note: body.note,
    depositSignature: body.depositSignature,
    force: Boolean(body.force),
  });

  res.json(
    jsonSafe({
      reference: result.intent.reference,
      orderId: result.orderId,
      orderCreated: result.created,
      pipeline: result.pipeline,
    }),
  );
}));

router.post('/api/deposits/:reference/cancel', ah(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { note?: string };
  const intent = await cancelIntent(String(req.params.reference ?? ''), body.note);
  res.json({ reference: intent.reference, status: intent.status });
}));

/** Varredura on-chain sob demanda — o mesmo motor que o cron e o poll usam. */
router.post('/api/deposits/scan', ah(async (_req: Request, res: Response) => {
  res.json(await scanOnchainDeposits());
}));

/** Pergunta ao PSP por todas as intenções em aberto, agora. */
router.post('/api/deposits/reconcile', ah(async (_req: Request, res: Response) => {
  res.json(await reconcilePspPayments());
}));

// ─────────────────────────── Taxas de gás ───────────────────────────

/**
 * Varre as taxas de gás acumuladas para `GAS_FEE_WALLET`.
 *
 * Move dinheiro: respeita a reserva de operação do vault e o lucro que ainda
 * pertence ao rateio dos sócios. O que sai é só o excedente.
 */
router.post('/api/gas/sweep', ah(async (_req: Request, res: Response) => {
  const result = await sweepGasFees();
  log.warn({ sol: result.sol, orders: result.orderCount }, 'varredura de gás disparada pelo admin');
  res.json(jsonSafe(result));
}));

// ─────────────────────── Pedidos de integração ───────────────────────

router.get('/api/applications', ah(async (req: Request, res: Response) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  res.json({ applications: await listApplications(status) });
}));

/**
 * Aprova: cria a loja e devolve as credenciais.
 *
 * A chave sai UMA vez — o banco guarda só o hash. Quem aprovar precisa copiar
 * agora e mandar para a loja por um canal seguro.
 */
router.post('/api/applications/:id/approve', ah(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { note?: string };
  const resultado = await approveApplication(String(req.params.id ?? ''), body.note);
  log.warn({ merchantId: resultado.merchantId }, 'pedido aprovado pelo admin');
  res.json(resultado);
}));

router.post('/api/applications/:id/reject', ah(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { note?: string };
  await rejectApplication(String(req.params.id ?? ''), body.note);
  res.json({ ok: true });
}));

// ─────────────────────────── Lojas integradas ───────────────────────────

router.get('/api/merchants', ah(async (_req: Request, res: Response) => {
  res.json({ merchants: await listMerchants() });
}));

/**
 * Cria a loja e devolve a chave de API.
 *
 * A chave aparece UMA vez: guardamos só o hash. Se a loja perder, o caminho é
 * rotacionar, não recuperar.
 */
router.post('/api/merchants', ah(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { name?: string; email?: string; callbackUrl?: string };
  const created = await createMerchant({
    name: String(body.name ?? ''),
    email: String(body.email ?? ''),
    callbackUrl: body.callbackUrl,
  });

  log.warn({ merchantId: created.merchant.id }, 'loja criada pelo admin');
  res.status(201).json({
    id: created.merchant.id,
    name: created.merchant.name,
    apiKey: created.apiKey,
    webhookSecret: created.webhookSecret,
  });
}));

router.post('/api/merchants/:id/rotate', ah(async (req: Request, res: Response) => {
  res.json({ apiKey: await rotateApiKey(String(req.params.id ?? '')) });
}));

router.post('/api/merchants/:id/active', ah(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { active?: boolean };
  await setMerchantActive(String(req.params.id ?? ''), body.active === true);
  res.json({ ok: true });
}));

// ─────────────────────────── Ordens ───────────────────────────

/**
 * Retoma as ordens paradas agora, sem esperar o tick.
 *
 * É o botão que o operador aperta depois de abastecer o vault: a fila de
 * entrega esvazia em segundos em vez de até cinco minutos.
 */
router.post('/api/orders/retry', ah(async (_req: Request, res: Response) => {
  res.json(await retryPendingOrders({ budgetMs: config.runtime.serverlessBudgetMs }));
}));

/**
 * Registra que o operador entregou o SOL por fora.
 *
 * Fecha a ordem sem passar pela pipeline. A assinatura é conferida na rede —
 * tem de existir, ter sucesso e ter creditado a carteira daquela ordem. Sem
 * assinatura, só com `withoutProof` explícito, e o registro fica marcado como
 * não verificado.
 */
router.post('/api/orders/:id/settle', ah(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { signature?: string; note?: string; withoutProof?: boolean };

  const result = await settleManually({
    orderId: String(req.params.id ?? ''),
    signature: body.signature,
    note: body.note,
    withoutProof: body.withoutProof === true,
    actor: 'admin',
  });

  log.warn({ orderId: result.orderId, verified: result.verified }, 'liquidação manual registrada');
  res.json(jsonSafe(result));
}));

/** Devolve uma ordem FAILED para a fila, se for seguro. */
router.post('/api/orders/:id/reopen', ah(async (req: Request, res: Response) => {
  res.json(await reopenOrder(String(req.params.id ?? ''), 'admin'));
}));

/** Desfaz um registro manual feito por engano. */
router.post('/api/orders/:id/settle/undo', ah(async (req: Request, res: Response) => {
  await undoManualSettlement(String(req.params.id ?? ''));
  res.json({ ok: true });
}));

/**
 * Livro-razão das ordens.
 *
 * Cada linha responde às perguntas que o operador faz às três da manhã: quem
 * pagou, quanto, **para qual carteira foi**, quanto ficou em fiat, e onde está
 * a prova on-chain. Sem a carteira de destino aqui, "para onde foi o dinheiro"
 * só teria resposta consultando o banco à mão.
 */
router.get('/api/orders', ah(async (req: Request, res: Response) => {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 25), 1), 100);
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;

  const orders = await prisma.order.findMany({
    ...(status ? { where: { status } } : {}),
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  // A intenção carrega a referência e o trilho; a conta, o e-mail. Duas
  // consultas em lote em vez de N — a tabela precisa abrir rápido.
  const [intents, wallets] = await Promise.all([
    prisma.depositIntent.findMany({
      where: { orderId: { in: orders.map((o) => o.id) } },
      select: {
        orderId: true,
        reference: true,
        method: true,
        pspPaymentId: true,
        customer: { select: { email: true } },
      },
    }),
    prisma.customerWallet.findMany({
      where: { publicKey: { in: orders.map((o) => o.customerWallet) } },
      select: { publicKey: true, revealedAt: true, customer: { select: { email: true } } },
    }),
  ]);

  const byOrder = new Map(intents.map((i) => [i.orderId, i]));
  const byWallet = new Map(wallets.map((w) => [w.publicKey, w]));

  res.json(
    jsonSafe({
      orders: orders.map((o) => {
        const intent = byOrder.get(o.id);
        const wallet = byWallet.get(o.customerWallet);
        return {
          id: o.id,
          reference: intent?.reference ?? null,
          method: intent?.method ?? o.provider,
          pspPaymentId: intent?.pspPaymentId ?? o.providerPaymentId,
          customerEmail: intent?.customer?.email ?? wallet?.customer?.email ?? null,
          status: o.status,
          fiat: `${o.fiatAmount.toString()} ${o.fiatCurrency}`,
          retainedFiat: o.retainedFiatAmount?.toString() ?? null,
          /** Para onde o SOL foi (ou vai). */
          customerWallet: o.customerWallet,
          /** true = carteira gerada por nós; a chave é nossa até ele exportar. */
          custodial: wallet !== undefined,
          keyExported: wallet?.revealedAt !== null && wallet?.revealedAt !== undefined,
          feeBps: o.feeBps,
          feeSourceProvider: o.feeSourceProvider,
          customerSol: o.customerLamports === null ? null : Number(o.customerLamports) / LAMPORTS_PER_SOL,
          profitSol: o.profitLamports === null ? null : Number(o.profitLamports) / LAMPORTS_PER_SOL,
          networkCostSol:
            o.networkCostLamports === null ? null : Number(o.networkCostLamports) / LAMPORTS_PER_SOL,
          swapSignature: o.swapSignature,
          customerPayoutSignature: o.customerPayoutSignature,
          payoutRunId: o.payoutRunId,
          attempts: o.attempts,
          lastError: o.lastError,
          manualSettlement: o.manualSettlement,
          settledBy: o.settledBy,
          settlementNote: o.settlementNote,
          createdAt: o.createdAt.toISOString(),
          settledAt: o.settledAt?.toISOString() ?? null,
        };
      }),
    }),
  );
}));

export default router;
