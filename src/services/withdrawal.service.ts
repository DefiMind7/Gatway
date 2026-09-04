import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import type { Withdrawal } from '@prisma/client';
import { config, LAMPORTS_PER_SOL } from '../config';
import { prisma } from '../database/client';
import { GatewayError } from '../types';
import { logger } from '../utils/logger';
import { withLockOrThrow } from './lock.service';
import { connection, getBalance, sendSignedTransaction } from './solana.service';
import { loadKeypair } from './wallet.service';
import type { AuthenticatedCustomer } from './customer.service';

/**
 * Saque: o cliente tira o SOL da carteira custodiada para onde ele quiser.
 *
 * Sem isto o modelo custodial é uma promessa vazia — dinheiro que entra e não
 * sai não é do cliente. Aqui ele escolhe qualquer endereço da rede Solana
 * (Phantom, Solflare, Backpack, conta de exchange) e nós assinamos com a chave
 * dele, que só existe cifrada no banco.
 *
 * Duas armadilhas da Solana que este módulo trata explicitamente:
 *
 *  • **Fee.** Quem paga a taxa é a conta que assina. Sacar "tudo" sem
 *    descontar a fee produz uma transação que falha por saldo insuficiente.
 *  • **Rent exemption.** Uma conta que ainda não existe na chain só é criada
 *    se receber pelo menos o mínimo rent-exempt (~0,00089 SOL). Mandar menos
 *    para um endereço novo queima a fee e não entrega nada.
 */

const log = logger.child({ scope: 'withdrawal' });

/** Fee de uma transferência simples com prioridade. Folga proposital. */
const FEE_BUFFER_LAMPORTS = 15_000n;

export const WithdrawalStatus = {
  SENT: 'SENT',
  FAILED: 'FAILED',
} as const;

export interface WithdrawalQuote {
  balanceLamports: bigint;
  /** O máximo que dá para sacar, já descontada a fee. */
  maxLamports: bigint;
  feeBufferLamports: bigint;
  minLamports: bigint;
}

/** Quanto dá para sacar agora. A página mostra isto antes de o cliente pedir. */
export async function quoteWithdrawal(walletAddress: string): Promise<WithdrawalQuote> {
  const balance = await getBalance(new PublicKey(walletAddress));
  const max = balance > FEE_BUFFER_LAMPORTS ? balance - FEE_BUFFER_LAMPORTS : 0n;

  return {
    balanceLamports: balance,
    maxLamports: max,
    feeBufferLamports: FEE_BUFFER_LAMPORTS,
    minLamports: config.distribution.minTransferLamports,
  };
}

export interface WithdrawInput {
  destination: string;
  /** SOL a enviar. Omitido = tudo o que dá, descontada a fee. */
  amountSol?: number | undefined;
  clientIp?: string | undefined;
}

export interface WithdrawResult {
  signature: string;
  lamports: bigint;
  sol: number;
  destination: string;
  explorer: string;
}

export async function withdraw(
  auth: AuthenticatedCustomer,
  input: WithdrawInput,
): Promise<WithdrawResult> {
  const destination = String(input.destination ?? '').trim();

  let destinationKey: PublicKey;
  try {
    destinationKey = new PublicKey(destination);
  } catch {
    throw new GatewayError(
      `endereço Solana inválido: "${destination}"`,
      'INVALID_DESTINATION',
      false,
    );
  }
  if (destination === auth.wallet.publicKey) {
    throw new GatewayError(
      'o destino é a própria carteira de origem',
      'DESTINATION_IS_SOURCE',
      false,
    );
  }
  if (destination === config.solana.vaultPublicKey.toBase58()) {
    throw new GatewayError(
      'esse endereço é o cofre do gateway — use a sua carteira externa',
      'DESTINATION_IS_VAULT',
      false,
    );
  }

  /**
   * Um saque por carteira por vez. Duas requisições simultâneas leriam o mesmo
   * saldo e assinariam duas transferências — a segunda falharia por saldo, mas
   * só depois de já ter sido transmitida.
   */
  return withLockOrThrow(
    `withdraw:${auth.wallet.id}`,
    async (): Promise<WithdrawResult> => {
      const quote = await quoteWithdrawal(auth.wallet.publicKey);

      const requested =
        input.amountSol === undefined
          ? quote.maxLamports
          : BigInt(Math.round(input.amountSol * LAMPORTS_PER_SOL));

      if (requested <= 0n) {
        throw new GatewayError('valor de saque inválido', 'INVALID_AMOUNT', false);
      }
      if (requested > quote.maxLamports) {
        throw new GatewayError(
          `saldo insuficiente: dá para sacar no máximo ${Number(quote.maxLamports) / LAMPORTS_PER_SOL} SOL ` +
            '(o resto fica para a taxa de rede)',
          'INSUFFICIENT_BALANCE',
          false,
          {
            balanceSol: Number(quote.balanceLamports) / LAMPORTS_PER_SOL,
            maxSol: Number(quote.maxLamports) / LAMPORTS_PER_SOL,
          },
        );
      }

      // Endereço que ainda não existe na chain precisa nascer rent-exempt.
      const destinationExists = (await connection.getAccountInfo(destinationKey)) !== null;
      if (!destinationExists && requested < config.distribution.minTransferLamports) {
        throw new GatewayError(
          `esse endereço ainda não existe na rede e precisa receber ao menos ` +
            `${Number(config.distribution.minTransferLamports) / LAMPORTS_PER_SOL} SOL para ser criado`,
          'BELOW_RENT_EXEMPT',
          false,
        );
      }

      const keypair = await loadKeypair(auth.wallet.id);
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

      const message = new TransactionMessage({
        payerKey: keypair.publicKey,
        recentBlockhash: blockhash,
        instructions: [
          ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: config.swap.priorityFeeMicroLamports,
          }),
          SystemProgram.transfer({
            fromPubkey: keypair.publicKey,
            toPubkey: destinationKey,
            lamports: requested,
          }),
        ],
      }).compileToV0Message();

      const transaction = new VersionedTransaction(message);
      transaction.sign([keypair]);

      /**
       * O registro nasce ANTES do envio. Se o processo morrer entre assinar e
       * confirmar, fica o rastro de que uma transferência pode estar em voo —
       * o contrário deixaria dinheiro saindo sem nada no banco.
       */
      const record = await prisma.withdrawal.create({
        data: {
          customerId: auth.customer.id,
          walletId: auth.wallet.id,
          destination,
          lamports: requested,
          status: WithdrawalStatus.SENT,
          ...(input.clientIp !== undefined ? { clientIp: input.clientIp } : {}),
        },
      });

      let signature: string;
      try {
        signature = await sendSignedTransaction(transaction, lastValidBlockHeight, {
          withdrawalId: record.id,
          wallet: auth.wallet.publicKey,
        });
      } catch (err) {
        await prisma.withdrawal.update({
          where: { id: record.id },
          data: {
            status: WithdrawalStatus.FAILED,
            lastError: (err instanceof Error ? err.message : String(err)).slice(0, 500),
          },
        });
        throw err;
      }

      await prisma.withdrawal.update({
        where: { id: record.id },
        data: { signature, confirmedAt: new Date() },
      });

      log.info(
        { withdrawalId: record.id, destination, sol: Number(requested) / LAMPORTS_PER_SOL, signature },
        'saque enviado',
      );

      return {
        signature,
        lamports: requested,
        sol: Number(requested) / LAMPORTS_PER_SOL,
        destination,
        explorer: `https://solscan.io/tx/${signature}`,
      };
    },
    { ttlMs: 90_000, meta: `withdraw ${auth.wallet.publicKey}` },
  );
}

/** Histórico de saques da conta. */
export async function listWithdrawals(customerId: string, limit = 20): Promise<Withdrawal[]> {
  return prisma.withdrawal.findMany({
    where: { customerId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}
