/**
 * Gera uma keypair nova para o vault.
 *
 *   npm run keygen            imprime a chave (útil para copiar à mão)
 *   npm run keygen -- --write grava direto no .env e imprime SÓ o endereço
 *
 * Prefira `--write`. A chave privada do vault controla todo o dinheiro que
 * passa pelo gateway; imprimi-la deixa cópia no histórico do terminal, no
 * scrollback e em qualquer ferramenta que esteja lendo a saída. Com `--write`
 * ela vai do gerador para o arquivo sem passar pela tela.
 *
 * Rotacionar o vault com saldo dentro deixa o dinheiro preso na chave antiga.
 * Só troque com o vault vazio — ou mova os fundos antes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const kp = Keypair.generate();
const address = kp.publicKey.toBase58();
const write = process.argv.includes('--write');

if (!write) {
  console.log('\n  Public key (endereço do vault):');
  console.log(`  ${address}\n`);
  console.log('  VAULT_PRIVATE_KEY (base58, formato Phantom):');
  console.log(`  ${bs58.encode(kp.secretKey)}\n`);
  console.log('  VAULT_PRIVATE_KEY (array, formato solana-keygen):');
  console.log(`  ${JSON.stringify(Array.from(kp.secretKey))}\n`);
  console.log('  Financie este endereço com SOL para as fees antes de usar.');
  console.log('  Dica: `npm run keygen -- --write` evita a chave passar pela tela.\n');
  process.exit(0);
}

const envPath = path.join(__dirname, '..', '.env');
if (!fs.existsSync(envPath)) {
  console.error('\n  .env não encontrado. Copie .env.example para .env primeiro.\n');
  process.exit(1);
}

const original = fs.readFileSync(envPath, 'utf8');

// Backup antes de sobrescrever: a chave antiga pode ainda ter saldo, e um
// arquivo perdido aqui é dinheiro perdido.
const backup = `${envPath}.bak-${Date.now()}`;
fs.writeFileSync(backup, original, { encoding: 'utf8' });

const line = `VAULT_PRIVATE_KEY=${bs58.encode(kp.secretKey)}`;
const updated = /^VAULT_PRIVATE_KEY=.*$/m.test(original)
  ? original.replace(/^VAULT_PRIVATE_KEY=.*$/m, line)
  : `${original.trimEnd()}\n${line}\n`;

fs.writeFileSync(envPath, updated, { encoding: 'utf8' });

console.log('\n  Vault novo gravado no .env. A chave privada não passou pela tela.\n');
console.log(`  Endereço do vault (mande o dinheiro para cá):\n  ${address}\n`);
console.log(`  Backup do .env anterior: ${path.basename(backup)}`);
console.log('  (contém a chave antiga — apague depois de confirmar que o vault antigo está vazio)\n');
