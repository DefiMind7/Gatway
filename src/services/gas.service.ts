import { PublicKey } from '@solana/web3.js';
import { config, LAMPORTS_PER_SOL } from '../config';
import { prisma } from '../database/client';
import { GatewayError, OrderStatus } from '../types';
import { logger } from '../utils/logger';
import { sendLamports } from './distribution.service';
import { LOCK_NAMES, withLock } from './lock.service';
import { getBalance } from './solana.service';

/**
 * Varredura das taxas de gás para a carteira do operador.
 *
 * O custo de rede é cobrado do cliente e fica no vault, porque é ele que paga
 * as taxas das próximas ordens. Este módulo move para fora só o que **passa da
 * reserva** — o excedente que já não tem função operacional.
 *
 * A ordem das prioridades importa e está codificada aqui:
 *
 *   1. reserva de fee — o vault precisa continuar conseguindo transmitir;
 *   2. lucro acumulado não distribuído — é dos sócios, não é gás;
 *   3. o que sobra — pode ir para a carteira de gás.
 *
 * Varrer sem respeitar (1) e (2) transformaria uma tela de conveniência num
 * jeito de travar o gateway ou de gastar dinheiro de terceiros.
 */

const log = logger.child({ scope: 'gas' });

export interface GasSweepStatus {
  /** Configurada em GAS_FEE_WALLET. */
  wallet: string | null;
  /** Custo de rede já cobrado dos clientes e ainda não varrido. */
  accruedLamports: bigint;
  /** Ordens que compõem esse total. */
  orderCount: number;
  /** Saldo atual do vault. */
  vaultLamports: bigint;
  /** O que dá para varrer agora, respeitando reserva e lucro dos sócios. */
  sweepableLamports: bigint;
  /** Por que não dá para varrer tudo o que foi acumulado, quando for o caso. */
  limitedBy: 'nada' | 'reserva' | 'lucro-nao-distribuido' | 'saldo';
}

export async function getGasSweepStatus(): Promise<GasSweepStatus> {
  const [pending, undistributed, vaultLamports] = await Promise.all([
    prisma.order.findMany({
      where: {
        gasSweptAt: null,
        networkCostLamports: { not: null },
        status: { in: [OrderStatus.SETTLED, OrderStatus.DISTRIBUTED] },
      },
      select: { networkCostLamports: true },
    }),
    // Lucro que ainda pertence ao rateio: não pode virar gás.
    prisma.order.findMany({
      where: { status: OrderStatus.SETTLED, payoutRunId: null },
      select: { profitLamports: true },
    }),
    getBalance().catch(() => 0n),
  ]);

  const accruedLamports = pending.reduce((acc, o) => acc + (o.networkCostLamports ?? 0n), 0n);
  const orderCount = pending.length;
  const profitLocked = undistributed.reduce((acc, o) => acc + (o.profitLamports ?? 0n), 0n);
  const reserve = config.distribution.feeReserveLamports;

  const free =
    vaultLamports > reserve + profitLocked ? vaultLamports - reserve - profitLocked : 0n;
  const sweepableLamports = accruedLamports < free ? accruedLamports : free;

  let limitedBy: GasSweepStatus['limitedBy'] = 'nada';
  if (sweepableLamports < accruedLamports) {
    if (vaultLamports <= reserve) limitedBy = 'reserva';
    else if (profitLocked > 0n) limitedBy = 'lucro-nao-distribuido';
    else limitedBy = 'saldo';
  }

  return {
    wallet: config.runtime.gasFeeWallet || null,
    accruedLamports,
    orderCount,
    vaultLamports,
    sweepableLamports,
    limitedBy,
  };
}

export interface GasSweepResult {
  signature: string | null;
  lamports: bigint;
  sol: number;
  orderCount: number;
  skipped?: string;
}

/**
 * Envia as taxas acumuladas para `GAS_FEE_WALLET`.
 *
 * Marca as ordens ANTES de transmitir: se o processo morrer no meio, o pior
 * caso é uma taxa não varrida (dinheiro parado no vault, recuperável na
 * próxima varredura manual) em vez de uma varredura dupla, que sacaria a
 * reserva de operação.
 */
export async function sweepGasFees(): Promise<GasSweepResult> {
  const wallet = config.runtime.gasFeeWallet;
  if (!wallet) {
    throw new GatewayError(
      'GAS_FEE_WALLET não configurada — não há para onde varrer',
      'GAS_WALLET_MISSING',
      false,
    );
  }
  if (wallet === config.solana.vaultPublicKey.toBase58()) {
    throw new GatewayError(
      'GAS_FEE_WALLET é o próprio vault — varredura não faz sentido',
      'GAS_WALLET_IS_VAULT',
      false,
    );
  }

  const outcome = await withLock(
    LOCK_NAMES.GAS_SWEEP,
    async (): Promise<GasSweepResult> => {
      const status = await getGasSweepStatus();

      if (status.sweepableLamports < config.distribution.minTransferLamports) {
        return {
          signature: null,
          lamports: 0n,
          sol: 0,
          orderCount: 0,
          skipped:
            `acumulado varrível (${Number(status.sweepableLamports) / LAMPORTS_PER_SOL} SOL) ` +
            `abaixo do mínimo transferível` +
            (status.limitedBy !== 'nada' ? ` — limitado por: ${status.limitedBy}` : ''),
        };
      }

      // Só as ordens que cabem no valor varrível entram nesta rodada.
      const candidates = await prisma.order.findMany({
        where: {
          gasSweptAt: null,
          networkCostLamports: { not: null },
          status: { in: [OrderStatus.SETTLED, OrderStatus.DISTRIBUTED] },
        },
        select: { id: true, networkCostLamports: true },
        orderBy: { settledAt: 'asc' },
      });

      const ids: string[] = [];
      let total = 0n;
      for (const order of candidates) {
        const cost = order.networkCostLamports ?? 0n;
        if (total + cost > status.sweepableLamports) break;
        total += cost;
        ids.push(order.id);
      }

      if (ids.length === 0 || total < config.distribution.minTransferLamports) {
        return { signature: null, lamports: 0n, sol: 0, orderCount: 0, skipped: 'nada a varrer' };
      }

      const sweptAt = new Date();
      await prisma.order.updateMany({ where: { id: { in: ids } }, data: { gasSweptAt: sweptAt } });

      let signature: string;
      try {
        signature = await sendLamports(wallet, total, { step: 'gas-sweep' });
      } catch (err) {
        // Devolve as ordens ao pool: o dinheiro não saiu.
        await prisma.order.updateMany({ where: { id: { in: ids } }, data: { gasSweptAt: null } });
        throw err;
      }

      log.info(
        { wallet, sol: Number(total) / LAMPORTS_PER_SOL, orders: ids.length, signature },
        'taxas de gás varridas para a carteira do operador',
      );

      return {
        signature,
        lamports: total,
        sol: Number(total) / LAMPORTS_PER_SOL,
        orderCount: ids.length,
      };
    },
    { ttlMs: 60_000, meta: 'gas sweep' },
  );

  if (!outcome.acquired) {
    throw new GatewayError('varredura de gás já em andamento', 'LOCK_UNAVAILABLE', true);
  }
  return outcome.result;
}

/** Só para o painel: confere que o endereço configurado é válido. */
export function gasWalletIsValid(): boolean {
  const wallet = config.runtime.gasFeeWallet;
  if (!wallet) return false;
  try {
    new PublicKey(wallet);
    return true;
  } catch {
    return false;
  }
}
