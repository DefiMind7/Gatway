import { PublicKey } from '@solana/web3.js';
import type { Order } from '@prisma/client';
import { LAMPORTS_PER_SOL } from '../config';
import { prisma } from '../database/client';
import { GatewayError, OrderStatus } from '../types';
import { logger } from '../utils/logger';
import { LOCK_NAMES, withLockOrThrow } from './lock.service';
import { connection } from './solana.service';

/**
 * Liquidação manual: o operador entregou o SOL por fora e registra aqui.
 *
 * É o fecho que faltava no modelo de conversão manual. Sem ele, uma ordem
 * paga e entregue à mão ficaria para sempre na fila do painel, e o operador
 * perderia a única visão confiável de quem ainda está esperando.
 *
 * A verificação on-chain não é burocracia. Um botão que aceita qualquer coisa
 * vira, no primeiro dia corrido, um jeito de marcar "entregue" o que não foi —
 * e aí o painel deixa de valer como fonte de verdade justamente sobre dinheiro
 * de terceiros. Aqui a assinatura é buscada na rede e conferida: precisa
 * existir, ter sucesso, e ter creditado a carteira daquela ordem.
 */

const log = logger.child({ scope: 'manual-settle' });

export interface ManualSettleInput {
  orderId: string;
  /** Assinatura da transação que entregou o SOL. */
  signature?: string | undefined;
  note?: string | undefined;
  actor: string;
  /**
   * Registra sem prova on-chain. Existe para o caso legítimo (entrega por
   * exchange, que não gera tx entre carteiras), e fica marcado como tal.
   */
  withoutProof?: boolean;
}

export interface ManualSettleResult {
  orderId: string;
  customerWallet: string;
  lamports: bigint;
  sol: number;
  signature: string | null;
  verified: boolean;
}

/** Quanto a transação creditou nesta carteira, em lamports. */
async function creditedTo(signature: string, wallet: string): Promise<bigint> {
  const tx = await connection.getParsedTransaction(signature, {
    maxSupportedTransactionVersion: 0,
    commitment: 'confirmed',
  });

  if (tx === null) {
    throw new GatewayError(
      'transação não encontrada na rede — confira a assinatura (ou aguarde a confirmação)',
      'TX_NOT_FOUND',
      false,
    );
  }
  if (tx.meta?.err != null) {
    throw new GatewayError(
      'a transação existe mas falhou na rede — nada foi entregue',
      'TX_FAILED',
      false,
    );
  }

  /**
   * O delta de saldo é mais confiável que ler instruções: cobre transferência
   * simples, transferência via programa, e qualquer caminho que tenha
   * creditado a conta.
   */
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
  const index = keys.indexOf(wallet);
  if (index === -1) {
    throw new GatewayError(
      `a transação não envolve a carteira do cliente (${wallet})`,
      'TX_WALLET_MISMATCH',
      false,
    );
  }

  const before = BigInt(tx.meta?.preBalances?.[index] ?? 0);
  const after = BigInt(tx.meta?.postBalances?.[index] ?? 0);
  const credited = after - before;

  if (credited <= 0n) {
    throw new GatewayError(
      'a transação não creditou SOL na carteira do cliente',
      'TX_NO_CREDIT',
      false,
    );
  }
  return credited;
}

export async function settleManually(input: ManualSettleInput): Promise<ManualSettleResult> {
  const order = await prisma.order.findUnique({ where: { id: input.orderId } });
  if (!order) {
    throw new GatewayError('ordem não encontrada', 'ORDER_NOT_FOUND', false);
  }

  return withLockOrThrow(
    LOCK_NAMES.order(order.id),
    async (): Promise<ManualSettleResult> => {
      const fresh = (await prisma.order.findUnique({ where: { id: order.id } })) as Order;

      if (fresh.status === OrderStatus.SETTLED || fresh.status === OrderStatus.DISTRIBUTED) {
        throw new GatewayError(
          'esta ordem já está liquidada — marcar de novo duplicaria a entrega no registro',
          'ALREADY_SETTLED',
          false,
        );
      }
      if (fresh.customerPayoutSignature !== null) {
        throw new GatewayError(
          `a ordem já tem uma transferência registrada (${fresh.customerPayoutSignature})`,
          'ALREADY_PAID',
          false,
        );
      }

      let lamports = 0n;
      let verified = false;
      const signature = input.signature?.trim() ?? '';

      if (signature !== '') {
        try {
          new PublicKey(fresh.customerWallet);
        } catch {
          throw new GatewayError('carteira da ordem inválida', 'INVALID_CUSTOMER_WALLET', false);
        }
        lamports = await creditedTo(signature, fresh.customerWallet);
        verified = true;
      } else if (input.withoutProof === true) {
        // Sem tx não há valor a observar. Fica registrado como não verificado.
        lamports = 0n;
      } else {
        throw new GatewayError(
          'informe a assinatura da transação, ou marque explicitamente que não há prova on-chain',
          'PROOF_REQUIRED',
          false,
        );
      }

      const note = [
        input.note?.trim() || null,
        verified ? null : 'registrado SEM prova on-chain',
      ]
        .filter(Boolean)
        .join(' · ');

      await prisma.order.update({
        where: { id: fresh.id },
        data: {
          status: OrderStatus.SETTLED,
          manualSettlement: true,
          settledBy: input.actor,
          ...(note ? { settlementNote: note } : {}),
          ...(signature !== '' ? { customerPayoutSignature: signature } : {}),
          ...(lamports > 0n ? { customerLamports: lamports } : {}),
          // Entrega por fora não gerou lucro on-chain: a receita desta ordem é
          // o fiat retido, e o rateio de SOL não tem o que distribuir aqui.
          profitLamports: 0n,
          settledAt: new Date(),
          lastError: null,
        },
      });

      log.warn(
        {
          orderId: fresh.id,
          wallet: fresh.customerWallet,
          sol: Number(lamports) / LAMPORTS_PER_SOL,
          signature: signature || null,
          verified,
          actor: input.actor,
        },
        'ordem liquidada manualmente pelo operador',
      );

      return {
        orderId: fresh.id,
        customerWallet: fresh.customerWallet,
        lamports,
        sol: Number(lamports) / LAMPORTS_PER_SOL,
        signature: signature || null,
        verified,
      };
    },
    { ttlMs: 60_000, meta: `manual settle ${order.id}` },
  );
}

/**
 * Devolve uma ordem FAILED para a fila.
 *
 * O caso comum é a ordem que morreu por uma trava de segurança conservadora
 * (processo reiniciado sem lastro no vault) e não por um problema real. A
 * recusa quando existe `swapSignature` é o que impede transformar isto num
 * jeito de swapar duas vezes: se o swap já saiu, reabrir exige entender o que
 * aconteceu on-chain primeiro.
 */
export async function reopenOrder(orderId: string, actor: string): Promise<{ status: string }> {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new GatewayError('ordem não encontrada', 'ORDER_NOT_FOUND', false);

  if (order.status !== OrderStatus.FAILED) {
    throw new GatewayError(
      `só ordens FAILED podem ser reabertas (esta está em ${order.status})`,
      'NOT_FAILED',
      false,
    );
  }
  if (order.swapSignature !== null) {
    throw new GatewayError(
      `esta ordem já tem um swap registrado (${order.swapSignature}) — reabrir sem entender ` +
        'o estado on-chain arriscaria um segundo swap. Confira no Solscan antes.',
      'SWAP_ALREADY_DONE',
      false,
    );
  }
  if (order.customerPayoutSignature !== null) {
    throw new GatewayError(
      'esta ordem já tem uma transferência para o cliente registrada',
      'ALREADY_PAID',
      false,
    );
  }

  await prisma.order.update({
    where: { id: orderId },
    data: {
      status: OrderStatus.PENDING,
      attempts: 0,
      lastError: `reaberta por ${actor}`,
    },
  });

  log.warn({ orderId, actor }, 'ordem reaberta para a fila');
  return { status: OrderStatus.PENDING };
}

/** Desfaz um registro manual feito por engano — só antes da distribuição. */
export async function undoManualSettlement(orderId: string): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new GatewayError('ordem não encontrada', 'ORDER_NOT_FOUND', false);
  if (!order.manualSettlement) {
    throw new GatewayError(
      'esta ordem não foi liquidada manualmente — não há registro manual a desfazer',
      'NOT_MANUAL',
      false,
    );
  }
  if (order.payoutRunId !== null) {
    throw new GatewayError(
      'a ordem já entrou numa execução de distribuição — desfazer aqui deixaria o histórico inconsistente',
      'ALREADY_DISTRIBUTED',
      false,
    );
  }

  await prisma.order.update({
    where: { id: orderId },
    data: {
      status: OrderStatus.PENDING,
      manualSettlement: false,
      settledBy: null,
      settlementNote: null,
      customerPayoutSignature: null,
      customerLamports: null,
      settledAt: null,
      lastError: 'registro manual desfeito pelo operador',
    },
  });

  log.warn({ orderId }, 'liquidação manual desfeita');
}
