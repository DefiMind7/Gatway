import { getAssociatedTokenAddress } from '@solana/spl-token';
import { PublicKey, type ParsedInstruction, type PartiallyDecodedInstruction } from '@solana/web3.js';
import { config } from '../config';
import { prisma } from '../database/client';
import { DepositIntentStatus, DepositMethod, GatewayError } from '../types';
import { logger } from '../utils/logger';
import { confirmFromPsp, confirmIntent, formatBaseUnits, getPublicView } from './deposit.service';
import { findPaymentByReference, isConfigured } from './mercadopago.service';
import { LOCK_NAMES, withLock } from './lock.service';
import { dispatchOrderPipeline } from './order.service';
import { connection } from './solana.service';

/**
 * Detecção on-chain de depósitos em USDC — o que torna o trilho USDC
 * automático de verdade.
 *
 * Como funciona: lê as assinaturas recentes da ATA de USDC do vault, soma o
 * que cada transação creditou nela, e confirma a intenção cujo
 * `expectedInputRaw` bate EXATAMENTE com esse valor.
 *
 * Por que casar por valor exato:
 *  • um memo/referência não sobrevive à maioria das carteiras (Phantom não
 *    manda memo em transferência de token pela UI);
 *  • o remetente também não serve — a carteira que paga muitas vezes não é a
 *    que recebe o SOL (exchange, carteira de terceiro).
 *
 * O valor é, portanto, o único identificador que o cliente consegue reproduzir
 * sem instrução extra. Isso tem uma consequência aceita de propósito: duas
 * intenções em aberto com o MESMO valor são ambíguas, e nesse caso o watcher
 * se recusa a decidir e deixa para o operador. Errar aqui pagaria SOL para a
 * carteira errada — um empate sem resolução é melhor do que um palpite.
 *
 * Idempotência: `depositSignature` é UNIQUE em `DepositIntent`, então a mesma
 * transferência nunca lastreia duas ordens, mesmo com varreduras concorrentes.
 */

const log = logger.child({ scope: 'deposit.watch' });

/** Uma intenção expirada ainda é confirmada se o dinheiro chegou até aqui. */
const EXPIRED_GRACE_MS = 2 * 3_600_000;

export interface ScanSummary {
  scanned: number;
  confirmed: Array<{ reference: string; signature: string; orderId: string }>;
  ambiguous: Array<{ signature: string; amount: string; references: string[] }>;
  unmatched: Array<{ signature: string; amount: string }>;
  skipped?: string;
}

const EMPTY: ScanSummary = { scanned: 0, confirmed: [], ambiguous: [], unmatched: [] };

/** Base units creditadas à ATA do vault por esta transação. */
function creditedToVault(
  instructions: Array<ParsedInstruction | PartiallyDecodedInstruction>,
  vaultAta: string,
): bigint {
  let total = 0n;

  for (const ix of instructions) {
    if (!('parsed' in ix) || ix.program !== 'spl-token') continue;
    const parsed = ix.parsed as { type?: string; info?: Record<string, unknown> } | null;
    if (parsed === null || parsed.info === undefined) continue;
    if (parsed.type !== 'transfer' && parsed.type !== 'transferChecked') continue;
    if (parsed.info.destination !== vaultAta) continue;

    // `transfer` traz `amount`; `transferChecked` embrulha em `tokenAmount`.
    const raw =
      parsed.type === 'transferChecked'
        ? (parsed.info.tokenAmount as { amount?: string } | undefined)?.amount
        : (parsed.info.amount as string | undefined);
    if (typeof raw !== 'string' || !/^\d+$/.test(raw)) continue;

    total += BigInt(raw);
  }

  return total;
}

/**
 * Varre e confirma o que casar.
 *
 * Chamada de dois lugares: do tick do cron e do polling da página de checkout
 * (throttlado pelo lock). O segundo é o que faz o depósito confirmar em
 * segundos numa plataforma serverless, onde o cron mais frequente disponível
 * pode ser diário.
 */
export async function scanOnchainDeposits(): Promise<ScanSummary> {
  if (!config.deposit.autoConfirm) {
    return { ...EMPTY, skipped: 'DEPOSIT_AUTOCONFIRM=false' };
  }
  if (!config.deposit.methods.includes(DepositMethod.USDC)) {
    return { ...EMPTY, skipped: 'trilho USDC desabilitado' };
  }

  const pending = await prisma.depositIntent.findMany({
    where: {
      method: DepositMethod.USDC,
      OR: [
        { status: DepositIntentStatus.AWAITING_PAYMENT },
        {
          status: DepositIntentStatus.EXPIRED,
          expiresAt: { gte: new Date(Date.now() - EXPIRED_GRACE_MS) },
        },
      ],
    },
    orderBy: { createdAt: 'asc' },
  });

  // Sem nada esperando não há o que casar — e a varredura custa chamadas de RPC.
  if (pending.length === 0) return { ...EMPTY, skipped: 'nenhuma intenção USDC em aberto' };

  const outcome = await withLock(
    LOCK_NAMES.DEPOSIT_SCAN,
    async () => {
      const vaultAta = (
        await getAssociatedTokenAddress(
          new PublicKey(config.swap.inputMint),
          config.solana.vaultPublicKey,
          true,
        )
      ).toBase58();

      const signatures = await connection.getSignaturesForAddress(new PublicKey(vaultAta), {
        limit: config.deposit.scanSignatures,
      });

      // Já usadas: nunca reaproveitar uma transferência que já lastreou ordem.
      const used = new Set(
        (
          await prisma.depositIntent.findMany({
            where: { depositSignature: { in: signatures.map((s) => s.signature) } },
            select: { depositSignature: true },
          })
        ).map((r) => r.depositSignature),
      );

      const summary: ScanSummary = { scanned: 0, confirmed: [], ambiguous: [], unmatched: [] };
      // Mais antigas primeiro: se dois depósitos iguais chegarem, a intenção
      // mais velha fica com a transferência mais velha.
      const candidates = signatures
        .filter((s) => s.err === null && !used.has(s.signature))
        .reverse();

      const openByAmount = new Map<string, typeof pending>();
      for (const intent of pending) {
        const key = intent.expectedInputRaw.toString();
        const list = openByAmount.get(key) ?? [];
        list.push(intent);
        openByAmount.set(key, list);
      }

      for (const { signature } of candidates) {
        const tx = await connection.getParsedTransaction(signature, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        });
        if (tx === null || tx.meta?.err != null) continue;
        summary.scanned += 1;

        const inner = (tx.meta?.innerInstructions ?? []).flatMap((group) => group.instructions);
        const credited = creditedToVault(
          [...tx.transaction.message.instructions, ...inner],
          vaultAta,
        );
        if (credited <= 0n) continue;

        const amount = formatBaseUnits(credited, config.swap.inputMintDecimals);
        const matches = openByAmount.get(credited.toString()) ?? [];

        if (matches.length === 0) {
          // Depósito sem intenção: dinheiro do float do operador, ou um cliente
          // que mandou valor diferente do combinado. Fica para o painel.
          summary.unmatched.push({ signature, amount });
          continue;
        }
        if (matches.length > 1) {
          summary.ambiguous.push({
            signature,
            amount,
            references: matches.map((m) => m.reference),
          });
          log.warn(
            { signature, amount, references: matches.map((m) => m.reference) },
            'depósito ambíguo: duas intenções com o mesmo valor — confirmação manual necessária',
          );
          continue;
        }

        const intent = matches[0]!;
        try {
          const result = await confirmIntent(intent.reference, {
            confirmedBy: 'onchain-watch',
            depositSignature: signature,
            // O dinheiro está verificavelmente na ATA: a expiração da cotação
            // não é motivo para deixar o cliente sem o SOL dele.
            force: true,
            note: `confirmado on-chain (${amount} USDC)`,
          });
          summary.confirmed.push({
            reference: intent.reference,
            signature,
            // Venda de loja não gera ordem — o campo carrega isso honestamente.
            orderId: result.orderId ?? '(venda de loja — sem entrega)',
          });
          // Consumida: não pode casar com outra transferência nesta varredura.
          openByAmount.set(credited.toString(), [] as unknown as typeof pending);
        } catch (err) {
          log.error(
            { reference: intent.reference, signature, err },
            'falha ao confirmar depósito detectado on-chain',
          );
        }
      }

      if (summary.confirmed.length > 0 || summary.ambiguous.length > 0) {
        log.info(
          {
            scanned: summary.scanned,
            confirmed: summary.confirmed.length,
            ambiguous: summary.ambiguous.length,
          },
          'varredura de depósitos concluída',
        );
      }
      return summary;
    },
    // TTL curto: o lock é exclusão E throttle. Ocupado = alguém varreu agora.
    { ttlMs: 20_000, meta: 'onchain deposit scan' },
  );

  if (!outcome.acquired) return { ...EMPTY, skipped: 'varredura já em andamento' };
  return outcome.result;
}

/**
 * Pergunta ao PSP se a intenção de cartão já foi paga.
 *
 * Este é o caminho que NÃO depende de webhook — e sem ele o trilho de cartão
 * não funciona em `localhost`, onde o Mercado Pago não tem como entregar
 * notificação nenhuma. Em produção ele cobre o webhook perdido: o MP desiste
 * depois de algumas tentativas, e um pagamento aprovado durante um deploy
 * ficaria invisível para sempre.
 *
 * O lock com TTL curto serve de throttle: cada intenção é consultada no
 * máximo uma vez a cada poucos segundos, por mais abas que o cliente abra.
 */
async function checkCardPayment(reference: string): Promise<string | null> {
  if (!isConfigured()) return null;

  const outcome = await withLock(
    `deposit:psp:${reference}`,
    async () => {
      const payment = await findPaymentByReference(reference);
      if (payment === null) return null;
      if (!payment.approved) {
        log.debug({ reference, status: payment.status }, 'pagamento no PSP ainda não aprovado');
        return null;
      }
      await confirmFromPsp(reference, payment);
      log.info({ reference, paymentId: payment.id }, 'pagamento de cartão confirmado por consulta');
      return payment.id;
    },
    { ttlMs: 8_000, meta: `psp check ${reference}` },
  );

  return outcome.acquired ? outcome.result : null;
}

/**
 * O que a página de checkout chama a cada poll.
 *
 * Três coisas, nesta ordem: varre a chain (se houver depósito USDC esperando),
 * lê o estado, e — só em serverless — empurra a pipeline de uma ordem que
 * ficou pelo caminho.
 *
 * O empurrão existe porque em serverless não há processo entre requisições: o
 * único trabalho de fundo é o cron, e no plano gratuito da Vercel ele roda uma
 * vez por dia. Sem isto, uma ordem cujo swap não caiu dentro do orçamento da
 * invocação ficaria PENDING até o dia seguinte. O poll do próprio cliente é o
 * relógio disponível.
 *
 * É seguro repetir: `processOrder` roda sob lock por ordem, cada etapa é
 * idempotente e `MAX_ATTEMPTS` limita o total de tentativas.
 */
export async function pollForCustomer(
  reference: string,
): Promise<{ view: Awaited<ReturnType<typeof getPublicView>>; scan: ScanSummary | null }> {
  let scan: ScanSummary | null = null;

  const before = await getPublicView(reference);
  let checked = false;

  if (before.status === DepositIntentStatus.AWAITING_PAYMENT) {
    if (before.method === DepositMethod.CARD) {
      checked = true;
      await checkCardPayment(reference).catch((err: unknown) => {
        // Erro de valor divergente ou credencial: fica no log e no painel, mas
        // não pode quebrar a página do cliente que está esperando.
        const level = err instanceof GatewayError && !err.retryable ? 'error' : 'warn';
        log[level]({ reference, err }, 'consulta ao PSP falhou');
        return null;
      });
    } else if (before.instructions.autoConfirm) {
      scan = await scanOnchainDeposits().catch((err: unknown) => {
        log.warn({ err }, 'varredura disparada pelo poll falhou');
        return null;
      });
      checked = scan !== null;
    }
  }

  const view = checked ? await getPublicView(reference) : before;

  const stalled =
    view.order !== null && (view.order.status === 'PENDING' || view.order.status === 'SWAPPED');

  if (config.isServerless && stalled) {
    const nudge = await withLock(
      `deposit:nudge:${view.order!.id}`,
      // Sob lock com TTL curto: um cliente com a aba aberta em dois
      // navegadores não dispara duas pipelines.
      async () => dispatchOrderPipeline(view.order!.id),
      { ttlMs: 30_000, meta: `poll ${view.reference}` },
    );
    if (nudge.acquired) return { view: await getPublicView(reference), scan };
  }

  return { view, scan };
}
