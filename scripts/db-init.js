#!/usr/bin/env node
/**
 * Cria as tabelas num Postgres de produção, sem quebrar o ambiente local.
 *
 *   npm run db:init -- "postgresql://usuario:senha@host/banco"
 *
 * Ou, se preferir não deixar a URL no histórico do terminal:
 *
 *   $env:DATABASE_URL_PROD = "postgresql://…"   # PowerShell
 *   npm run db:init
 *
 * O schema do Prisma guarda o provider dentro do arquivo, então apontar para
 * Postgres exige editá-lo. Este script faz isso, aplica, e **devolve o arquivo
 * ao estado de SQLite** — inclusive se algo falhar no meio. Sem esse cuidado,
 * o próximo `npm run dev` quebraria com um erro que não tem nada a ver com o
 * que a pessoa estava fazendo.
 *
 * A URL nunca é impressa.
 */
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const RAIZ = path.join(__dirname, '..');
const SCHEMA = 'src/database/schema.prisma';

const url = process.argv[2] || process.env.DATABASE_URL_PROD;

if (!url || !url.startsWith('postgres')) {
  console.error(`
  Falta a URL do Postgres.

  Onde encontrar:
    • Vercel → projeto → Storage → o banco → .env.local → POSTGRES_PRISMA_URL
    • Supabase → Project Settings → Database → Connection string → URI

  Use assim:

    npm run db:init -- "postgresql://usuario:senha@host:5432/postgres"

  Ou, para não deixar a senha no histórico do terminal:

    $env:DATABASE_URL_PROD = "postgresql://…"
    npm run db:init
`);
  process.exit(1);
}

function prisma(args, env = {}) {
  return execFileSync('npx', ['prisma', ...args], {
    cwd: RAIZ,
    stdio: 'inherit',
    env: { ...process.env, ...env },
    shell: true,
  });
}

function setProvider(provider) {
  execFileSync('node', ['scripts/set-db-provider.js', provider], { cwd: RAIZ, stdio: 'pipe' });
}

const host = (() => {
  try {
    return new URL(url).host;
  } catch {
    return '(host ilegível)';
  }
})();

console.log(`\n═══ Criando as tabelas em ${host} ═══\n`);

let ok = false;
try {
  setProvider('postgresql');
  console.log('  schema apontado para postgres');

  prisma(['generate', '--schema', SCHEMA]);
  prisma(['db', 'push', '--schema', SCHEMA, '--skip-generate', '--accept-data-loss'], {
    DATABASE_URL: url,
  });

  ok = true;
} catch (err) {
  console.error('\n  falhou:', err instanceof Error ? err.message : err);
} finally {
  // Sempre volta o local para SQLite, mesmo se a migração falhar.
  try {
    setProvider('sqlite');
    execFileSync('npx', ['prisma', 'generate', '--schema', SCHEMA], {
      cwd: RAIZ, stdio: 'pipe', shell: true,
    });
    console.log('\n  ambiente local devolvido para SQLite');
  } catch {
    console.error('\n  ATENÇÃO: não consegui devolver o schema para sqlite.');
    console.error('  Rode à mão antes de continuar localmente:  npm run db:sqlite');
  }
}

if (ok) {
  console.log(`
═══ Tabelas criadas ═══

  Agora dispare um redeploy na Vercel — ou espere o próximo push.
  Depois disso o app sai do 503.
`);
} else {
  process.exit(1);
}
