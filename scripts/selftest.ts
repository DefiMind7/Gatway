/**
 * Primeiro depósito real, de ponta a ponta, num comando.
 *
 *   npm run selftest -- --amount 5 --wallet <SUA_CARTEIRA>
 *   npm run selftest -- --amount 5                 (gera uma carteira)
 *
 * Faz exatamente o que um cliente faria, mas pulando o pagamento: cria a
 * intenção, confirma como se o dinheiro tivesse caído, e acompanha a pipeline
 * até o SOL chegar. Serve para provar, com dinheiro real e valor pequeno, as
 * três etapas que nunca foram executadas de verdade neste projeto — swap,
 * liquidação e entrega.
 *
 * Não move fiat nenhum. O que ele consome é o float de USDC do vault, que é o
 * que uma venda de verdade consumiria.
 */
import { config, LAMPORTS_PER_SOL } from '../src/config';
import { prisma } from '../src/database/client';
import {
  confirmIntent,
  createIntent,
  getFloatStatus,
  getPublicView,
} from '../src/services/deposit.service';
import { getBalance } from '../src/services/solana.service';
import { OrderStatus } from '../src/types';

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx === -1 ? undefined : process.argv[idx + 1];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Trilho fiat qualquer serve: o que importa é a etapa on-chain. */
function pickRail(): string {
  const fiat = config.deposit.methods.filter((m) => m !== 'USDC');
  if (fiat.length === 0) {
    throw new Error(
      'nenhum trilho fiat habilitado. Ponha PIX ou CARD em DEPOSIT_METHODS para rodar o selftest.',
    );
  }
  return fiat[0]!;
}

async function main(): Promise<void> {
  const amount = Number(arg('amount') ?? config.deposit.minAmount);
  const wallet = arg('wallet');
  const currency = arg('currency') ?? 'USD';
  const decimals = config.swap.inputMintDecimals;

  console.log('\n═══ Selftest: depósito real de ponta a ponta ═══\n');

  // ── 0) Pré-condições. Falhar aqui é barato. ──
  const [float, vaultSol] = await Promise.all([getFloatStatus(), getBalance()]);
  const freeUsdc = Number(float.availableRaw) / 10 ** decimals;
  const sol = Number(vaultSol) / LAMPORTS_PER_SOL;

  console.log(`vault ......... ${config.solana.vaultPublicKey.toBase58()}`);
  console.log(`gás ........... ${sol.toFixed(4)} SOL`);
  console.log(`float livre ... ${freeUsdc.toFixed(2)} USDC`);
  console.log(`rede .......... ${new URL(config.solana.rpcEndpoint).host}\n`);

  if (vaultSol < config.distribution.feeReserveLamports) {
    throw new Error(
      `sem SOL para as taxas de rede (tem ${sol.toFixed(4)}, precisa de ` +
        `${Number(config.distribution.feeReserveLamports) / LAMPORTS_PER_SOL}). ` +
        'Envie SOL para o vault e rode de novo.',
    );
  }

  const rail = pickRail();

  // ── 1) Intenção, como a do cliente ──
  const { intent } = await createIntent({
    method: rail,
    currency,
    amount,
    ...(wallet !== undefined ? { customerWallet: wallet } : {}),
  });

  const view = await getPublicView(intent.reference);
  console.log(`1) intenção ${intent.reference} (${rail})`);
  console.log(`   cliente paga ....... ${view.amountToPay}`);
  // A composição do preço não sai mais na visão pública (é do operador, não
  // do cliente) — aqui ela vem da própria intenção no banco.
  if (intent.retainedFiatAmount !== null) {
    console.log(`   fica em fiat ....... ${intent.retainedFiatAmount.toString()} ${view.fiatCurrency}`);
  }
  console.log(`   consome do float ... ${Number(intent.expectedInputRaw) / 10 ** decimals} USDC`);
  console.log(`   destino ............ ${view.wallet.address}`);
  console.log(`   carteira nossa? .... ${view.wallet.generated ? 'sim (gerada agora)' : 'não (informada)'}\n`);

  // ── 2) Confirmação: onde o dinheiro fiat "entrou" ──
  console.log('2) confirmando (simula o dinheiro caindo na conta)…');
  const result = await confirmIntent(intent.reference, {
    confirmedBy: 'selftest',
    note: 'selftest — nenhum fiat foi movido',
    force: true,
  });
  if (result.orderId === null) {
    // Venda de loja não gera ordem: o dinheiro vira saldo da loja.
    console.log('   venda de loja confirmada (sem entrega de cripto)\n');
    await prisma.$disconnect();
    return;
  }
  console.log(`   ordem ${result.orderId} criada\n`);

  // ── 3) A parte que nunca tinha rodado: swap + liquidação ──
  console.log('3) aguardando swap e liquidação on-chain…');
  const deadline = Date.now() + 5 * 60_000;
  let last = '';

  while (Date.now() < deadline) {
    const order = await prisma.order.findUnique({ where: { id: result.orderId } });
    if (!order) throw new Error('ordem desapareceu');

    if (order.status !== last) {
      console.log(`   ${new Date().toLocaleTimeString()}  ${order.status}`);
      last = order.status;
    }

    if (order.status === OrderStatus.SETTLED || order.status === OrderStatus.DISTRIBUTED) {
      const customerSol = Number(order.customerLamports ?? 0n) / LAMPORTS_PER_SOL;
      console.log('\n═══ FUNCIONOU ═══\n');
      console.log(`SOL entregue ..... ${customerSol.toFixed(9)}`);
      console.log(`para ............. ${order.customerWallet}`);
      console.log(`swap ............. https://solscan.io/tx/${order.swapSignature}`);
      console.log(`liquidação ....... https://solscan.io/tx/${order.customerPayoutSignature}`);
      if (order.retainedFiatAmount) {
        console.log(
          `retido em fiat ... ${order.retainedFiatAmount.toString()} ${order.fiatCurrency} ` +
            '(na sua conta, não na chain)',
        );
      }
      console.log('');
      await prisma.$disconnect();
      process.exit(0);
    }

    if (order.status === OrderStatus.FAILED) {
      console.log(`\n═══ FALHOU ═══\n${order.lastError}\n`);
      await prisma.$disconnect();
      process.exit(1);
    }

    await sleep(3_000);
  }

  console.log(
    '\nA ordem não terminou em 5 minutos. Ela não se perdeu: veja o estado em /admin ' +
      'e o motivo em `lastError`.\n',
  );
  await prisma.$disconnect();
  process.exit(1);
}

main().catch(async (err: unknown) => {
  console.error(`\nselftest parou: ${err instanceof Error ? err.message : String(err)}\n`);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
