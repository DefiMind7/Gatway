#!/usr/bin/env node
/**
 * Deploy completo na Vercel, de uma vez.
 *
 *   VERCEL_TOKEN=xxx node scripts/deploy.js            # mostra o plano
 *   VERCEL_TOKEN=xxx node scripts/deploy.js --apply    # executa
 *
 * Faz, nesta ordem:
 *   1. vincula a pasta ao projeto (cria se não existir);
 *   2. envia as variáveis do `.env` para os três ambientes;
 *   3. cria as tabelas no Postgres, se a DATABASE_URL já existir;
 *   4. dispara o deploy de produção.
 *
 * Por que um script e não uma sequência de comandos à mão: cada `vercel env
 * add` é interativo e lê o valor do stdin. Vinte variáveis assim, digitadas
 * uma a uma, é onde nasce o espaço sobrando numa chave que vira um 401 sem
 * explicação três dias depois.
 *
 * O token nunca é impresso, nem os valores das variáveis.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const RAIZ = path.join(__dirname, '..');
const ENV_FILE = path.join(RAIZ, '.env');
const AMBIENTES = ['production', 'preview', 'development'];

/**
 * `DATABASE_URL` sai daqui de propósito: quem a define é a integração de
 * Postgres da Vercel. Sobrescrevê-la com o valor local (SQLite) quebraria o
 * deploy de um jeito difícil de enxergar.
 */
const IGNORAR = new Set([
  'DATABASE_URL',
  'DATABASE_PROVIDER',
  'PORT',
  'NODE_ENV',
  'LOG_LEVEL',
  'MERCADOPAGO_API_BASE',
]);

const FORCADOS = { NODE_ENV: 'production', LOG_LEVEL: 'info' };

const token = process.env.VERCEL_TOKEN;
const apply = process.argv.includes('--apply');
const nomeProjeto = process.env.VERCEL_PROJECT || 'gatway';

if (!token) {
  console.error(`
  Falta o token da Vercel.

  Crie em:  https://vercel.com/account/tokens
    • Scope: a sua conta
    • Expiration: o mais curto que sirva (24h basta)

  Depois:

    $env:VERCEL_TOKEN = "seu_token"        # PowerShell
    node scripts/deploy.js --apply
`);
  process.exit(1);
}

function vercel(args, { silencioso = false } = {}) {
  const r = spawnSync('npx', ['vercel', ...args, '--token', token], {
    cwd: RAIZ,
    encoding: 'utf8',
    shell: true,
  });
  const saida = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (!silencioso && saida.trim()) {
    // Nunca ecoa o token, mesmo que a CLI o repita numa mensagem de erro.
    console.log(saida.split(token).join('***').trim().split('\n').map((l) => `    ${l}`).join('\n'));
  }
  return { code: r.status ?? 1, saida };
}

/** Envia uma variável para um ambiente, substituindo se já existir. */
function enviarVariavel(nome, valor, ambiente) {
  // `env add` falha se a variável já existe; remover antes torna o script
  // repetível, que é o que se quer num deploy.
  spawnSync('npx', ['vercel', 'env', 'rm', nome, ambiente, '--yes', '--token', token], {
    cwd: RAIZ, encoding: 'utf8', shell: true,
  });

  const r = spawnSync('npx', ['vercel', 'env', 'add', nome, ambiente, '--token', token], {
    cwd: RAIZ,
    input: `${valor}\n`,
    encoding: 'utf8',
    shell: true,
  });
  return (r.status ?? 1) === 0;
}

function lerEnv() {
  if (!fs.existsSync(ENV_FILE)) {
    console.error('  .env não encontrado.');
    process.exit(1);
  }
  const out = {};
  for (const bruto of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const linha = bruto.trim();
    if (!linha || linha.startsWith('#') || !linha.includes('=')) continue;
    const i = linha.indexOf('=');
    const chave = linha.slice(0, i).trim();
    let valor = linha.slice(i + 1).trim();
    if (valor.length >= 2 && valor[0] === valor[valor.length - 1] && (valor[0] === '"' || valor[0] === "'")) {
      valor = valor.slice(1, -1);
    }
    if (!IGNORAR.has(chave) && valor) out[chave] = valor;
  }
  return { ...out, ...FORCADOS };
}

function mascarar(valor) {
  if (valor.length <= 8) return '•'.repeat(valor.length);
  return `${valor.slice(0, 4)}…${valor.slice(-2)} (${valor.length} chars)`;
}

async function main() {
  const variaveis = lerEnv();

  console.log('\n═══ Deploy na Vercel ═══\n');
  console.log(`  projeto ....... ${nomeProjeto}`);
  console.log(`  variáveis ..... ${Object.keys(variaveis).length}`);
  console.log(`  ambientes ..... ${AMBIENTES.join(', ')}`);
  console.log(`  modo .......... ${apply ? 'APLICAR' : 'prévia (use --apply para executar)'}\n`);

  for (const [nome, valor] of Object.entries(variaveis)) {
    console.log(`    ${nome.padEnd(30)} ${mascarar(valor)}`);
  }

  if (!apply) {
    console.log('\n  Prévia. Para executar de verdade:\n');
    console.log('    node scripts/deploy.js --apply\n');
    return;
  }

  // ── 1) vincular ──
  console.log('\n1) vinculando a pasta ao projeto…');
  const link = vercel(['link', '--yes', '--project', nomeProjeto]);
  if (link.code !== 0) {
    console.error('\n  Falhou ao vincular. O token tem acesso a este projeto?\n');
    process.exit(1);
  }

  // ── 2) variáveis ──
  console.log('\n2) enviando variáveis…');
  let enviadas = 0;
  let falhas = 0;
  for (const [nome, valor] of Object.entries(variaveis)) {
    const ok = AMBIENTES.every((amb) => enviarVariavel(nome, valor, amb));
    if (ok) enviadas += 1;
    else {
      falhas += 1;
      console.log(`    FALHOU: ${nome}`);
    }
  }
  console.log(`    ${enviadas} enviadas, ${falhas} falharam`);

  // ── 3) banco ──
  console.log('\n3) verificando o banco…');
  const pull = vercel(['env', 'pull', '.vercel/.env.production', '--environment', 'production'], {
    silencioso: true,
  });
  const arquivoEnv = path.join(RAIZ, '.vercel', '.env.production');
  let databaseUrl = null;

  if (pull.code === 0 && fs.existsSync(arquivoEnv)) {
    const conteudo = fs.readFileSync(arquivoEnv, 'utf8');
    const m = conteudo.match(/^(?:POSTGRES_PRISMA_URL|DATABASE_URL|POSTGRES_URL)="?([^"\n]+)"?/m);
    if (m) databaseUrl = m[1];
  }

  if (!databaseUrl) {
    console.log(`
    Nenhum Postgres conectado ainda.

    Crie um destes jeitos:
      • painel:  projeto → Storage → Create Database → Postgres
      • CLI:     npx vercel integration add neon --token <TOKEN>

    Depois rode este script de novo: ele detecta a URL e cria as tabelas.
`);
  } else {
    console.log('    Postgres encontrado. Criando as tabelas…');
    try {
      execFileSync('node', ['scripts/set-db-provider.js', 'postgresql'], { cwd: RAIZ, stdio: 'pipe' });
      execFileSync('npx', ['prisma', 'db', 'push', '--schema', 'src/database/schema.prisma', '--skip-generate'], {
        cwd: RAIZ,
        stdio: 'inherit',
        env: { ...process.env, DATABASE_URL: databaseUrl },
        shell: true,
      });
      console.log('    tabelas criadas.');
    } catch (err) {
      console.error('    falha ao criar as tabelas:', err instanceof Error ? err.message : err);
    } finally {
      // O ambiente local volta a ser SQLite: deixar o schema em postgres aqui
      // quebraria o próximo `npm run dev`.
      execFileSync('node', ['scripts/set-db-provider.js', 'sqlite'], { cwd: RAIZ, stdio: 'pipe' });
      execFileSync('npx', ['prisma', 'generate', '--schema', 'src/database/schema.prisma'], {
        cwd: RAIZ, stdio: 'pipe', shell: true,
      });
    }
  }

  // ── 4) deploy ──
  console.log('\n4) publicando em produção…');
  const deploy = vercel(['deploy', '--prod', '--yes']);
  if (deploy.code !== 0) {
    console.error('\n  Deploy falhou. Veja o log acima.\n');
    process.exit(1);
  }

  const url = (deploy.saida.match(/https:\/\/[^\s]+\.vercel\.app/g) || []).pop();
  console.log('\n═══ Pronto ═══\n');
  if (url) {
    console.log(`  checkout ... ${url}/pay`);
    console.log(`  painel ..... ${url}/admin`);
    console.log(`  API docs ... ${url}/docs`);
    console.log(`\n  Falta ainda: definir PUBLIC_BASE_URL=${url} e cadastrar o webhook`);
    console.log(`  ${url}/pay/mercadopago/webhook no painel do Mercado Pago.\n`);
  }
}

main().catch((err) => {
  console.error('\ndeploy falhou:', err instanceof Error ? err.message : err);
  process.exit(1);
});
