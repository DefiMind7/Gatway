import { config } from '../config';
import { logger } from '../utils/logger';
import { pruneExpiredLocks } from './lock.service';
import { retryPendingOrders } from './order.service';
import { reconcilePspPayments } from './reconcile.service';
import { expireStaleIntents } from './deposit.service';
import { runProfitDistribution } from './payout.service';
import { computeNextRunAt, getSettings } from './settings.service';

/**
 * Agendador do horário fixo diário da distribuição de lucro.
 *
 * Usa `setTimeout` recalculado a cada disparo em vez de um cron por intervalo:
 * assim o horário acompanha a timezone configurada e sobrevive a horário de
 * verão (o próximo instante é recalculado do zero, sempre a partir do relógio
 * de parede da timezone).
 *
 * Também roda um varredor periódico de ordens inacabadas — sem ele, uma ordem
 * que falha por erro transitório só seria retomada no próximo boot.
 */

const log = logger.child({ scope: 'scheduler' });

/** Teto do setTimeout no Node (~24.8 dias); o nosso alvo é sempre < 24h. */
const MAX_TIMEOUT_MS = 2_147_483_647;
const SWEEP_INTERVAL_MS = 5 * 60 * 1_000;

/**
 * A reconciliação com o PSP roda bem mais rápido que a varredura de ordens.
 *
 * É ela que descobre um Pix pago depois de o cliente fechar a aba — e a
 * diferença entre um minuto e cinco é a diferença entre "caiu na hora" e "o
 * cliente escreveu perguntando".
 */
const RECONCILE_INTERVAL_MS = 60 * 1_000;

let distributionTimer: NodeJS.Timeout | null = null;
let sweepTimer: NodeJS.Timeout | null = null;
let reconcileTimer: NodeJS.Timeout | null = null;
let nextRunAt: Date | null = null;
let started = false;

export function getNextRunAt(): Date | null {
  return nextRunAt;
}

/**
 * (Re)agenda o próximo disparo. Chamado no boot, após cada execução e sempre
 * que o admin muda o horário — por isso é idempotente: limpa o timer anterior.
 */
export async function scheduleNextRun(): Promise<Date | null> {
  if (distributionTimer) {
    clearTimeout(distributionTimer);
    distributionTimer = null;
  }

  const settings = await getSettings(true);
  if (!settings.distributionEnabled) {
    nextRunAt = null;
    log.warn('distribuição automática DESABILITADA nas configurações');
    return null;
  }

  const target = computeNextRunAt(
    settings.distributionHour,
    settings.distributionMinute,
    settings.distributionTimezone,
  );
  nextRunAt = target;

  const delay = Math.min(Math.max(target.getTime() - Date.now(), 0), MAX_TIMEOUT_MS);
  distributionTimer = setTimeout(() => {
    void fire(target);
  }, delay);
  distributionTimer.unref();

  log.info(
    {
      nextRunAt: target.toISOString(),
      inMinutes: Math.round(delay / 60_000),
      localTime: `${String(settings.distributionHour).padStart(2, '0')}:${String(
        settings.distributionMinute,
      ).padStart(2, '0')} ${settings.distributionTimezone}`,
    },
    'próxima distribuição de lucro agendada',
  );

  return target;
}

async function fire(scheduledFor: Date): Promise<void> {
  log.info({ scheduledFor: scheduledFor.toISOString() }, 'disparando distribuição agendada');
  try {
    const summary = await runProfitDistribution({ trigger: 'SCHEDULED', scheduledFor });
    log.info({ summary }, 'distribuição agendada finalizada');
  } catch (err) {
    // Falhar aqui não pode matar o agendamento: o próximo ciclo tenta de novo,
    // e o estado da execução ficou registrado no banco.
    log.error({ err }, 'distribuição agendada falhou');
  } finally {
    await scheduleNextRun().catch((err: unknown) =>
      log.error({ err }, 'falha ao reagendar a distribuição'),
    );
  }
}

export async function startScheduler(): Promise<void> {
  if (started) return;
  started = true;

  if (config.isServerless) {
    // `setTimeout` de horas não sobrevive a uma função que morre após a
    // resposta. Em serverless o disparo tem de vir de um cron EXTERNO batendo
    // em POST /admin/api/distribution/cron — ver vercel.json e DEPLOY.md.
    log.warn(
      'runtime serverless: agendador in-process NÃO iniciado. ' +
        'A distribuição e a retomada de ordens dependem de um cron externo ' +
        'chamando GET /admin/cron/tick. O horário/timezone configurados no admin ' +
        'são ignorados neste runtime — quem manda é o schedule do cron.',
    );
    return;
  }

  await scheduleNextRun();

  sweepTimer = setInterval(() => {
    void retryPendingOrders()
      // Sem isto, intenções vencidas ficavam AWAITING_PAYMENT para sempre em
      // host persistente — só o tick do cron (serverless) as expirava.
      .then(() => expireStaleIntents())
      .then(() => pruneExpiredLocks())
      .catch((err: unknown) => log.error({ err }, 'varredura de ordens pendentes falhou'));
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  reconcileTimer = setInterval(() => {
    void reconcilePspPayments()
      .then((summary) => {
        // Só vale log quando algo aconteceu: uma linha por minuto sem novidade
        // esconderia justamente a linha que importa.
        if (summary.confirmed.length > 0) {
          void retryPendingOrders().catch((err: unknown) =>
            log.error({ err }, 'pipeline após reconciliação falhou'),
          );
        }
      })
      .catch((err: unknown) => log.error({ err }, 'reconciliação com o PSP falhou'));
  }, RECONCILE_INTERVAL_MS);
  reconcileTimer.unref();

  log.info(
    {
      sweepMinutes: SWEEP_INTERVAL_MS / 60_000,
      reconcileSeconds: RECONCILE_INTERVAL_MS / 1_000,
    },
    'agendador iniciado',
  );
}

export function stopScheduler(): void {
  if (distributionTimer) clearTimeout(distributionTimer);
  if (sweepTimer) clearInterval(sweepTimer);
  if (reconcileTimer) clearInterval(reconcileTimer);
  distributionTimer = null;
  sweepTimer = null;
  reconcileTimer = null;
  started = false;
}
