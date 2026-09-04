/**
 * Pré-voo: verifica, uma a uma, as condições para receber dinheiro de gente
 * de verdade.
 *
 *   npm run preflight
 *
 * Existe porque as falhas deste sistema não são barulhentas. Um vault sem
 * float, um RPC de devnet, uma credencial de teste — nada disso quebra o boot.
 * Quebra na hora em que um cliente já pagou, que é o pior momento possível.
 *
 * Cada verificação diz o que está errado E o que fazer. Sai com código 1 se
 * houver qualquer bloqueio, para poder virar passo de CI ou de deploy.
 */
import { config, LAMPORTS_PER_SOL } from '../src/config';
import { prisma } from '../src/database/client';
import { getFloatStatus } from '../src/services/deposit.service';
import { getPendingDelivery } from '../src/services/order.service';
import { getQuote } from '../src/services/jupiter.service';
import { isConfigured, supportsEmbeddedCheckout } from '../src/services/mercadopago.service';
import { getBalance } from '../src/services/solana.service';
import { getSettings } from '../src/services/settings.service';
import { walletStats } from '../src/services/wallet.service';

type Level = 'ok' | 'aviso' | 'bloqueio';

interface Check {
  level: Level;
  title: string;
  detail: string;
  fix?: string;
}

const checks: Check[] = [];
const add = (c: Check) => checks.push(c);

/** USDC oficial em mainnet. Serve para detectar mint de devnet ou trocado. */
const USDC_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

async function run(): Promise<void> {
  const decimals = config.swap.inputMintDecimals;
  const host = new URL(config.solana.rpcEndpoint).host;
  const isMainnet = !/devnet|testnet/i.test(config.solana.rpcEndpoint);

  // ── Rede ──
  if (!isMainnet) {
    add({
      level: 'bloqueio',
      title: 'RPC aponta para devnet/testnet',
      detail: `RPC_ENDPOINT = ${host}`,
      fix: 'Troque para um RPC de mainnet. O Jupiter não tem liquidez em devnet, então o swap nunca completa lá.',
    });
  } else if (/api\.mainnet-beta\.solana\.com/.test(config.solana.rpcEndpoint)) {
    add({
      level: 'aviso',
      title: 'RPC público da Solana',
      detail: host,
      fix: 'O endpoint público tem rate limit agressivo e derruba swaps sob carga. Use Helius ou QuickNode.',
    });
  } else {
    add({ level: 'ok', title: 'RPC de mainnet', detail: host });
  }

  // ── Mint de entrada ──
  if (isMainnet && config.swap.inputMint !== USDC_MAINNET) {
    add({
      level: 'bloqueio',
      title: 'INPUT_MINT não é o USDC de mainnet',
      detail: config.swap.inputMint,
      fix: `Em mainnet use ${USDC_MAINNET}. Um mint de devnet aqui faz a pipeline esperar um depósito que nunca chega.`,
    });
  } else {
    add({ level: 'ok', title: 'Mint de entrada', detail: config.swap.inputMint });
  }

  // ── Gás do vault ──
  const vaultLamports = await getBalance().catch(() => null);
  if (vaultLamports === null) {
    add({
      level: 'bloqueio',
      title: 'RPC não respondeu',
      detail: 'não foi possível ler o saldo do vault',
      fix: 'Verifique RPC_ENDPOINT e a chave de API do provedor.',
    });
  } else {
    const sol = Number(vaultLamports) / LAMPORTS_PER_SOL;
    const reserve = Number(config.distribution.feeReserveLamports) / LAMPORTS_PER_SOL;
    if (vaultLamports < config.distribution.feeReserveLamports) {
      add({
        level: 'bloqueio',
        title: 'Vault sem SOL para taxas de rede',
        detail: `${sol.toFixed(4)} SOL (reserva exigida: ${reserve.toFixed(4)})`,
        fix:
          `Envie ao menos ${reserve.toFixed(3)} SOL para ${config.solana.vaultPublicKey.toBase58()}. ` +
          'Não dá para transmitir transação na Solana com saldo zero — quem assina paga a taxa. ' +
          'Este valor é capital de giro: cada ordem devolve o custo ao vault (NETWORK_COST_LAMPORTS).',
      });
    } else {
      add({ level: 'ok', title: 'Gás do vault', detail: `${sol.toFixed(4)} SOL` });
    }
  }

  // ── Float de USDC ──
  const float = await getFloatStatus();
  const available = Number(float.availableRaw) / 10 ** decimals;
  const balance = Number(float.balanceRaw) / 10 ** decimals;

  if (float.availableRaw === 0n) {
    /**
     * Sem a trava de float o modelo é "receber agora, converter depois": a
     * falta de estoque atrasa a entrega, não impede a venda. Continua sendo
     * bloqueio quando a trava está ligada, porque aí nenhum depósito passa.
     */
    add({
      level: config.deposit.requireFloat ? 'bloqueio' : 'aviso',
      title: config.deposit.requireFloat
        ? 'Vault sem float de USDC'
        : 'Vault sem float — clientes vão esperar pela entrega',
      detail: `saldo ${balance.toFixed(2)} USDC, livre ${available.toFixed(2)}`,
      fix: config.deposit.requireFloat
        ? `Envie USDC para ${config.solana.vaultPublicKey.toBase58()}. É esse estoque que lastreia os ` +
          'depósitos em cartão e Pix: o cliente paga em fiat na sua conta e o SOL sai deste saldo.'
        : 'Cada venda vai para a fila de entrega até você comprar USDC e abastecer o vault. ' +
          'Acompanhe "Aguardando entrega" no painel — é dinheiro de cliente esperando.',
    });
  } else if (available < config.deposit.maxAmount) {
    add({
      level: 'aviso',
      title: 'Float menor que o depósito máximo permitido',
      detail: `livre ${available.toFixed(2)} USDC, DEPOSIT_MAX_AMOUNT ${config.deposit.maxAmount}`,
      fix: 'Baixe DEPOSIT_MAX_AMOUNT ou aumente o float. Depósitos acima do float são recusados na hora (o que é o comportamento certo).',
    });
  } else {
    add({ level: 'ok', title: 'Float de USDC', detail: `${available.toFixed(2)} USDC livres` });
  }

  if (!config.deposit.requireFloat) {
    add({
      level: 'aviso',
      title: 'Modelo de conversão manual (trava de float desligada)',
      detail: 'DEPOSIT_REQUIRE_FLOAT=false',
      fix:
        'O gateway aceita vendas que ainda não consegue entregar. É deliberado — mas cada ordem ' +
        'na fila é um cliente que pagou e está esperando, e o preço do SOL se move nesse intervalo.',
    });
  }

  // ── Jupiter ──
  try {
    const probe = BigInt(10 ** decimals); // 1 USDC
    const quote = await getQuote(probe);
    add({
      level: 'ok',
      title: 'Jupiter respondendo',
      detail: `1 USDC ≈ ${(Number(quote.outAmount) / LAMPORTS_PER_SOL).toFixed(6)} SOL`,
    });
  } catch (err) {
    add({
      level: 'bloqueio',
      title: 'Jupiter não cotou',
      detail: err instanceof Error ? err.message : String(err),
      fix: 'Sem cotação não há swap. Em devnet isto é esperado e não tem conserto: precisa ser mainnet.',
    });
  }

  // ── Mercado Pago ──
  if (config.deposit.methods.includes('CARD')) {
    if (!isConfigured()) {
      add({
        level: 'bloqueio',
        title: 'CARD habilitado sem credencial do Mercado Pago',
        detail: 'MERCADOPAGO_ACCESS_TOKEN vazio',
        fix: 'Cole o Access Token de produção.',
      });
    } else {
      const token = config.mercadopago.accessToken;
      const isTestToken = token.startsWith('TEST-');
      add({
        level: isTestToken ? 'aviso' : 'ok',
        title: 'Credencial do Mercado Pago',
        detail: isTestToken ? 'token de TESTE' : 'token de produção (APP_USR)',
        ...(isTestToken
          ? { fix: 'Cliente real não paga com credencial de teste. Troque antes de abrir.' }
          : {}),
      });

      if (!supportsEmbeddedCheckout()) {
        add({
          level: 'aviso',
          title: 'Checkout embutido indisponível',
          detail: 'MERCADOPAGO_PUBLIC_KEY vazia',
          fix: 'Sem ela o cliente é redirecionado para a página do Mercado Pago em vez de pagar no seu site.',
        });
      }
      if (!config.mercadopago.webhookSecret && config.isProduction) {
        add({
          level: 'aviso',
          title: 'Webhook do MP sem segredo',
          detail: 'MERCADOPAGO_WEBHOOK_SECRET vazio',
          fix: 'Em produção o webhook é recusado sem ele. A confirmação ainda funciona por consulta ativa, só mais devagar.',
        });
      }
      if (!config.mercadopago.publicBaseUrl) {
        add({
          level: 'aviso',
          title: 'PUBLIC_BASE_URL vazia',
          detail: 'sem URL pública',
          fix: 'Defina no deploy para o MP conseguir chamar o webhook e devolver o cliente à sua página.',
        });
      }
    }
  }

  // ── Custódia ──
  if (config.wallet.enabled) {
    const stats = await walletStats();
    add({
      level: 'ok',
      title: 'Carteiras custodiadas',
      detail: `${stats.total} geradas, ${stats.revealed} com chave entregue`,
    });
    add({
      level: 'aviso',
      title: 'WALLET_ENCRYPTION_KEY tem backup fora deste servidor?',
      detail: 'só você pode responder',
      fix: 'Perder essa chave é perder o dinheiro de todos os clientes. Guarde uma cópia num gerenciador de senhas.',
    });
  }

  // ── Retenção e limites ──
  const settings = await getSettings();
  add({
    level: 'ok',
    title: 'Divisão do dinheiro',
    detail: `${(settings.fiatRetainedBps / 100).toFixed(2)}% fica em fiat, ${((10_000 - settings.fiatRetainedBps) / 100).toFixed(2)}% vira SOL`,
  });
  add({
    level: config.deposit.maxAmount > 100 ? 'aviso' : 'ok',
    title: 'Teto por depósito',
    detail: `${config.deposit.minAmount} a ${config.deposit.maxAmount}`,
    ...(config.deposit.maxAmount > 100
      ? { fix: 'Nos primeiros dias com dinheiro real, um teto baixo limita o prejuízo de um estorno ou de um bug.' }
      : {}),
  });

  const pending = await getPendingDelivery();
  if (pending.count > 0) {
    add({
      level: 'bloqueio',
      title: `${pending.count} cliente(s) pagaram e não receberam`,
      detail: `faltam ${(Number(pending.requiredRaw) / 10 ** decimals).toFixed(2)} USDC no vault`,
      fix: 'Compre o USDC, envie para o vault e clique em "Retomar ordens agora" no painel.',
    });
  }

  if (!config.runtime.allowPipeline) {
    add({
      level: 'bloqueio',
      title: 'Pipeline desligada',
      detail: 'ALLOW_PIPELINE=false',
      fix: 'Ordens são registradas mas nenhum SOL é enviado.',
    });
  }

  // ── Relatório ──
  const icon: Record<Level, string> = { ok: '  OK   ', aviso: ' AVISO ', bloqueio: 'BLOQUEIO' };
  console.log('\n═══ Pré-voo do gateway ═══\n');
  for (const c of checks) {
    console.log(`[${icon[c.level]}] ${c.title}`);
    console.log(`            ${c.detail}`);
    if (c.fix) console.log(`            → ${c.fix}`);
    console.log('');
  }

  const blockers = checks.filter((c) => c.level === 'bloqueio');
  const warnings = checks.filter((c) => c.level === 'aviso');

  if (blockers.length === 0) {
    console.log(`Pronto para receber dinheiro real. ${warnings.length} aviso(s) para revisar.\n`);
  } else {
    console.log(`${blockers.length} BLOQUEIO(S): não abra para clientes ainda.\n`);
  }

  await prisma.$disconnect();
  process.exit(blockers.length === 0 ? 0 : 1);
}

run().catch((err: unknown) => {
  console.error('\npré-voo falhou:', err instanceof Error ? err.message : err);
  process.exit(1);
});
