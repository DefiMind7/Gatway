#!/usr/bin/env node
/**
 * Preparo de uma cópia nova para teste.
 *
 *   npm run setup
 *
 * Gera as chaves próprias desta instalação, escreve o `.env` e cria o banco.
 * Existe para que quem recebe o projeto consiga rodar sem entender ainda o que
 * é vault, chave de cifra ou câmbio do operador — essas decisões vêm depois,
 * quando a pessoa já viu o sistema de pé.
 *
 * O que NÃO faz, de propósito: não inventa credencial de Mercado Pago nem
 * chave de produção. A instalação nasce com o trilho USDC, que funciona sem
 * provedor externo; Pix e cartão entram quando houver credencial de verdade.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Keypair } = require('@solana/web3.js');
// bs58 v6 é ESM com default export; sob require() ele chega embrulhado.
const bs58mod = require('bs58');
const bs58 = bs58mod.default ?? bs58mod;

const RAIZ = path.join(__dirname, '..');
const ENV = path.join(RAIZ, '.env');

if (fs.existsSync(ENV)) {
  console.log(`
  Já existe um .env aqui — não vou sobrescrever.

  Para começar do zero: apague o .env e rode de novo.
  Para só recriar o banco:  npm run prisma:push
`);
  process.exit(0);
}

console.log('\n═══ Preparando esta instalação ═══\n');

// ── Chaves próprias desta cópia ──
// Cada instalação gera as suas. Compartilhar um .env entre pessoas seria
// compartilhar o vault e as carteiras dos clientes.
const vault = Keypair.generate();
const vaultKey = bs58.encode(vault.secretKey);
const walletKey = crypto.randomBytes(32).toString('hex');
const adminKey = `admin_${crypto.randomBytes(20).toString('hex')}`;
const cronSecret = `cron_${crypto.randomBytes(20).toString('hex')}`;
const webhookSecret = `whsec_${crypto.randomBytes(16).toString('hex')}`;

console.log('  chaves geradas para esta cópia (não são as de ninguém mais)');

const env = `# Gerado por \`npm run setup\`. NUNCA comite este arquivo.

NODE_ENV=development
PORT=3000
LOG_LEVEL=info

# ── Solana ──
# Endpoint público: serve para testar. Para uso real, prefira Helius ou
# QuickNode — o público tem rate limit agressivo e derruba swap sob carga.
RPC_ENDPOINT=https://api.mainnet-beta.solana.com
RPC_SEND_ENDPOINT=

# Vault desta instalação. Recebe o USDC e assina as transações.
# O endereço público é ${vault.publicKey.toBase58()}
VAULT_PRIVATE_KEY=${vaultKey}

# ── Provedor fiat externo (não usado no teste) ──
FIAT_PROVIDER=spherepay
FIAT_PROVIDER_SECRET=${webhookSecret}
WEBHOOK_TOLERANCE_SECONDS=300

# ── Divisão do lucro entre sócios ──
# Endereços de exemplo: troque pelos reais antes de distribuir qualquer coisa.
RECIPIENTS_JSON='[{"label":"Carteira A","address":"11111111111111111111111111111112","bps":10000}]'

# ── Swap ──
JUPITER_API_BASE=https://lite-api.jup.ag/swap/v1
INPUT_MINT=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
INPUT_MINT_DECIMALS=6
SLIPPAGE_BPS=50
PRIORITY_FEE_MICRO_LAMPORTS=200000

# ── Reservas ──
FEE_RESERVE_LAMPORTS=2000000
NETWORK_COST_LAMPORTS=200000
GAS_FEE_WALLET=
MIN_TRANSFER_LAMPORTS=890880
MAX_TRANSFERS_PER_TX=18
MAX_ATTEMPTS=3
DEPOSIT_WAIT_TIMEOUT_MS=180000

# ── Depósitos ──
# Começa só com USDC: é o único trilho que funciona sem credencial de
# provedor. Para ligar Pix e cartão, ponha as credenciais do Mercado Pago
# abaixo e troque para: DEPOSIT_METHODS=PIXQR,CARD
DEPOSIT_ENABLED=true
DEPOSIT_METHODS=USDC
DEPOSIT_INSTRUCTIONS_JSON='{}'
DEPOSIT_MIN_AMOUNT=1
DEPOSIT_MAX_AMOUNT=25
DEPOSIT_INTENT_TTL_MINUTES=45
DEPOSIT_AUTOCONFIRM=true
DEPOSIT_SCAN_SIGNATURES=30
DEPOSIT_MAX_INTENTS_PER_HOUR=50
DEPOSIT_REQUIRE_FLOAT=false

# ── Mercado Pago (Pix e cartão) ──
# mercadopago.com.br/developers → Suas integrações → Credenciais
MERCADOPAGO_ACCESS_TOKEN=
MERCADOPAGO_PUBLIC_KEY=
MERCADOPAGO_WEBHOOK_SECRET=
MERCADOPAGO_SANDBOX=false
MERCADOPAGO_SITE=MLB
PUBLIC_BASE_URL=

# ── Carteiras dos clientes ──
# PERDER ESTA CHAVE É PERDER O DINHEIRO DOS CLIENTES. Ela cifra as chaves
# privadas no banco; sem ela, nem você abre as carteiras.
WALLET_GENERATION=true
WALLET_ENCRYPTION_KEY=${walletKey}

# ── Acesso ──
ADMIN_API_KEY=${adminKey}
CRON_SECRET=${cronSecret}

# ── Limites de segurança ──
MAX_PRICE_IMPACT_BPS=300
MAX_ORDER_INPUT_RAW=50000000000
FEE_CACHE_TTL_MS=300000

DATABASE_URL="file:./gateway.db"
`;

fs.writeFileSync(ENV, env, 'utf8');
console.log('  .env criado');

// ── Banco ──
console.log('  criando o banco…');
try {
  /**
   * O `generate` pode falhar se já houver um servidor rodando: no Windows ele
   * segura o arquivo do motor do Prisma e a regravação dá EPERM. Não é motivo
   * para abortar — o `npm install` já gerou o cliente, e o que interessa aqui
   * é o passo seguinte, que cria as tabelas.
   */
  try {
    execFileSync('npx', ['prisma', 'generate', '--schema', 'src/database/schema.prisma'], {
      cwd: RAIZ, stdio: 'pipe', shell: true,
    });
  } catch {
    console.log('  (cliente do Prisma já existia — seguindo)');
  }

  execFileSync('npx', ['prisma', 'db', 'push', '--schema', 'src/database/schema.prisma', '--skip-generate'], {
    cwd: RAIZ, stdio: 'pipe', shell: true,
  });
  console.log('  banco pronto');
} catch (err) {
  console.error('\n  falha ao criar o banco:', err instanceof Error ? err.message : err);
  console.error('  tente à mão: npx prisma db push --schema src/database/schema.prisma\n');
  process.exit(1);
}

console.log(`
═══ Pronto ═══

  Suba com:   npm run dev

  Checkout ...... http://localhost:3000/pay
  Painel ........ http://localhost:3000/admin
  API (docs) .... http://localhost:3000/docs

  Senha do painel (está no .env, em ADMIN_API_KEY):

    ${adminKey}

  Vault desta instalação:

    ${vault.publicKey.toBase58()}

  O trilho USDC já funciona. Para Pix e cartão, ponha as credenciais do
  Mercado Pago no .env e troque DEPOSIT_METHODS para PIXQR,CARD.

  Para entregar SOL de verdade, o vault precisa de saldo: ~0,003 SOL para as
  taxas de rede e USDC como estoque. Confira o que falta com:

    npm run preflight
`);
