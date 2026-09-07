import { prisma } from '../database/client';
import { DepositIntentStatus, DepositMethod, GatewayError } from '../types';
import { logger } from '../utils/logger';
import { confirmFromPsp } from './deposit.service';
import { LOCK_NAMES, withLock } from './lock.service';
import { findPaymentByReference, isConfigured, listApprovedPayments } from './mercadopago.service';

/**
 * Reconciliação com o provedor de pagamento.
 *
 * Fecha o buraco mais perigoso do fluxo: até aqui, quem descobria que um Pix
 * ou cartão foi pago era o **poll da página do cliente**. Se ele fechasse a
 * aba depois de pagar — o que é exatamente o que uma pessoa faz depois de
 * pagar — ninguém mais perguntava ao Mercado Pago, e o dinheiro ficava na
 * conta do operador sem ordem nenhuma associada.
 *
 * Aqui o servidor pergunta sozinho, de tempos em tempos, por todas as
 * intenções em aberto. Não depende de navegador, de webhook, nem de URL
 * pública — funciona em localhost.
 *
 * Convive com os outros dois caminhos sem duplicar nada: a confirmação é
 * idempotente (uma intenção gera no máximo uma ordem, garantido pelo UNIQUE em
 * `providerEventId`), então webhook, poll e esta varredura podem chegar juntos.
 */

const log = logger.child({ scope: 'reconcile' });

/** Trilhos cujo estado vive no PSP. */
const PSP_METHODS = [DepositMethod.PIXQR, DepositMethod.CARD];

/**
 * Janela de busca. Uma intenção vencida há muito tempo não vale mais uma
 * chamada de API a cada varredura — e um pagamento que chega dias depois é
 * caso para o operador olhar, não para o robô decidir.
 */
const LOOKBACK_MS = 24 * 3_600_000;

export interface ReconcileSummary {
  checked: number;
  confirmed: Array<{ reference: string; paymentId: string; orderId: string }>;
  stillOpen: number;
  failed: Array<{ reference: string; error: string }>;
  skipped?: string;
}

const EMPTY: ReconcileSummary = { checked: 0, confirmed: [], stillOpen: 0, failed: [] };

export async function reconcilePspPayments(): Promise<ReconcileSummary> {
  if (!isConfigured()) return { ...EMPTY, skipped: 'PSP não configurado' };

  const candidates = await prisma.depositIntent.findMany({
    where: {
      method: { in: PSP_METHODS },
      status: { in: [DepositIntentStatus.AWAITING_PAYMENT, DepositIntentStatus.EXPIRED] },
      createdAt: { gte: new Date(Date.now() - LOOKBACK_MS) },
    },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });

  if (candidates.length === 0) return { ...EMPTY, skipped: 'nada em aberto' };

  const outcome = await withLock(
    LOCK_NAMES.PSP_RECONCILE,
    async (): Promise<ReconcileSummary> => {
      const summary: ReconcileSummary = { checked: 0, confirmed: [], stillOpen: 0, failed: [] };

      for (const intent of candidates) {
        summary.checked += 1;

        let payment;
        try {
          payment = await findPaymentByReference(intent.reference);
        } catch (err) {
          // Erro de rede/API não pode interromper a varredura das outras.
          summary.failed.push({
            reference: intent.reference,
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }

        if (payment === null || !payment.approved) {
          summary.stillOpen += 1;
          continue;
        }

        try {
          const result = await confirmFromPsp(intent.reference, payment);
          summary.confirmed.push({
            reference: intent.reference,
            paymentId: payment.id,
            // Venda de loja não gera ordem — o campo carrega isso honestamente.
            orderId: result.orderId ?? '(venda de loja — sem entrega)',
          });
          log.warn(
            { reference: intent.reference, paymentId: payment.id, orderId: result.orderId },
            'pagamento encontrado na reconciliação — o cliente pagou e ninguém tinha visto',
          );
        } catch (err) {
          // Valor divergente, intenção cancelada: fica para o operador.
          const message = err instanceof GatewayError ? err.message : String(err);
          summary.failed.push({ reference: intent.reference, error: message });
          log.error({ reference: intent.reference, err: message }, 'reconciliação não confirmou');
        }
      }

      if (summary.confirmed.length > 0) {
        log.info(
          { confirmed: summary.confirmed.length, checked: summary.checked },
          'reconciliação recuperou pagamentos',
        );
      }
      return summary;
    },
    { ttlMs: 60_000, meta: 'psp reconcile' },
  );

  if (!outcome.acquired) return { ...EMPTY, skipped: 'reconciliação já em andamento' };
  return outcome.result;
}

export interface OrphanPayment {
  paymentId: string;
  amount: number | null;
  currency: string | null;
  method: string | null;
  reference: string | null;
  /** Por que não foi atribuído. */
  reason: 'sem-referencia' | 'referencia-desconhecida' | 'intencao-nao-confirmada';
}

/**
 * Dinheiro que entrou na conta e o sistema não consegue atribuir.
 *
 * Três casos, todos reais:
 *  • pagamento sem `external_reference` — cobrança criada fora do gateway;
 *  • referência que não existe no nosso banco — outro ambiente, ou banco
 *    restaurado sem aquele registro;
 *  • referência conhecida, mas a intenção não está confirmada — foi o caso do
 *    QR pago depois de a página ser fechada.
 *
 * O terceiro é o que a reconciliação normal resolve sozinha; aparecer aqui
 * significa que ela falhou por algum motivo, e isso precisa ser visível.
 */
export async function findOrphanPayments(days = 7): Promise<OrphanPayment[]> {
  if (!isConfigured()) return [];

  const payments = await listApprovedPayments(days);
  if (payments.length === 0) return [];

  const references = payments
    .map((p) => p.externalReference)
    .filter((r): r is string => r !== null);

  const intents =
    references.length === 0
      ? []
      : await prisma.depositIntent.findMany({
          where: { reference: { in: references } },
          select: { reference: true, status: true, pspPaymentId: true },
        });
  const byReference = new Map(intents.map((i) => [i.reference, i]));

  const orphans: OrphanPayment[] = [];

  for (const payment of payments) {
    const base = {
      paymentId: payment.id,
      amount: payment.amount,
      currency: payment.currency,
      method: payment.paymentMethod,
      reference: payment.externalReference,
    };

    if (payment.externalReference === null) {
      orphans.push({ ...base, reason: 'sem-referencia' });
      continue;
    }

    const intent = byReference.get(payment.externalReference);
    if (!intent) {
      orphans.push({ ...base, reason: 'referencia-desconhecida' });
      continue;
    }
    if (intent.status !== DepositIntentStatus.CONFIRMED) {
      orphans.push({ ...base, reason: 'intencao-nao-confirmada' });
    }
  }

  if (orphans.length > 0) {
    log.warn(
      { count: orphans.length },
      'pagamentos aprovados sem ordem correspondente — dinheiro na conta sem destino',
    );
  }
  return orphans;
}
