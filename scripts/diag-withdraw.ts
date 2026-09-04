/**
 * Diagnóstico de saque, sem mover dinheiro.
 *
 *   npm run diag:withdraw -- --email <conta> [--to <endereço>] [--sol 0.001]
 *
 * Monta exatamente a transação que o botão "Enviar" montaria e a **simula** na
 * rede: descobre o motivo real da recusa sem transmitir nada. Existe porque
 * "deu erro" numa tela não diz se o problema é saldo, endereço, taxa ou RPC —
 * e adivinhar isso com dinheiro de cliente no meio é caro.
 */
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { config, LAMPORTS_PER_SOL } from '../src/config';
import { prisma } from '../src/database/client';
import { connection } from '../src/services/solana.service';
import { loadKeypair } from '../src/services/wallet.service';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const email = arg('email');
  if (!email) throw new Error('use --email <conta>');

  const customer = await prisma.customer.findUnique({
    where: { email: email.toLowerCase() },
    include: { wallet: true },
  });
  if (!customer) throw new Error(`conta não encontrada: ${email}`);

  const from = new PublicKey(customer.wallet.publicKey);
  const balance = BigInt(await connection.getBalance(from, 'confirmed'));

  console.log(`\nconta ....... ${customer.email}`);
  console.log(`carteira .... ${from.toBase58()}`);
  console.log(`saldo ....... ${Number(balance) / LAMPORTS_PER_SOL} SOL (${balance} lamports)`);

  const destination = new PublicKey(
    arg('to') ?? config.solana.vaultPublicKey.toBase58(),
  );
  const info = await connection.getAccountInfo(destination);
  console.log(`destino ..... ${destination.toBase58()} (${info ? 'já existe' : 'NÃO existe — precisa nascer rent-exempt'})`);

  const requested = arg('sol')
    ? BigInt(Math.round(Number(arg('sol')) * LAMPORTS_PER_SOL))
    : balance > 15_000n
      ? balance - 15_000n
      : 0n;
  console.log(`enviando .... ${Number(requested) / LAMPORTS_PER_SOL} SOL`);

  if (requested <= 0n) {
    console.log('\nsem saldo para enviar.\n');
    await prisma.$disconnect();
    return;
  }

  const keypair = await loadKeypair(customer.wallet.id);
  const { blockhash } = await connection.getLatestBlockhash('confirmed');

  const message = new TransactionMessage({
    payerKey: keypair.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: config.swap.priorityFeeMicroLamports,
      }),
      SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey: destination,
        lamports: requested,
      }),
    ],
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  tx.sign([keypair]);

  // Simulação: a rede executa e devolve o erro, sem gravar nada.
  const sim = await connection.simulateTransaction(tx, { commitment: 'confirmed' });

  console.log('\n── simulação ──');
  if (sim.value.err === null) {
    console.log('PASSOU: a transação seria aceita. O saque funciona para estes valores.');
  } else {
    console.log('FALHOU:', JSON.stringify(sim.value.err));
  }
  const fee = await connection.getFeeForMessage(message, 'confirmed').catch(() => null);
  if (fee?.value != null) {
    console.log(`taxa estimada: ${fee.value} lamports (${fee.value / LAMPORTS_PER_SOL} SOL)`);
    const total = requested + BigInt(fee.value);
    console.log(`envio + taxa : ${total} lamports · saldo ${balance} · ${total > balance ? 'NÃO CABE' : 'cabe'}`);
  }
  for (const line of sim.value.logs ?? []) console.log('   ', line);

  await prisma.$disconnect();
}

main().catch(async (err: unknown) => {
  console.error('\ndiagnóstico falhou:', err instanceof Error ? err.message : err);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
