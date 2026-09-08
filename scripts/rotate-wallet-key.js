#!/usr/bin/env node
/**
 * Troca a WALLET_ENCRYPTION_KEY re-cifrando tudo que depende dela.
 *
 * Por que isto existe: uma cifra sem plano de troca de chave não é uma postura
 * de segurança, é uma aposta. No dia em que a chave vazar — um `.env` num
 * print, um ex-funcionário, um log distraído — a única resposta possível é
 * trocá-la. Sem este caminho, trocar significaria tornar ilegível a chave
 * privada de todos os clientes, o que é pior que o vazamento.
 *
 * O QUE ELE RE-CIFRA
 *   • CustomerWallet — a chave privada Solana de cada cliente
 *   • Merchant.aiKey — a chave da Anthropic de cada loja
 *
 * COMO ROTACIONAR, na ordem (a ordem é o que evita perder dados)
 *
 *   1. Gere a chave nova:            npm run walletkey
 *   2. No ambiente (Vercel), ponha:
 *        WALLET_ENCRYPTION_KEY           = a NOVA
 *        WALLET_ENCRYPTION_KEY_PREVIOUS  = a ANTIGA
 *      Faça deploy. A partir daqui o app lê os dois formatos: o que ainda está
 *      na chave antiga continua abrindo, e o que for gravado já sai na nova.
 *   3. Ensaie, sem gravar nada:
 *        npm run rotate:walletkey
 *   4. Aplique:
 *        npm run rotate:walletkey -- --apply
 *   5. Confirme que sobrou zero na chave antiga e só então REMOVA
 *      WALLET_ENCRYPTION_KEY_PREVIOUS do ambiente, com um novo deploy.
 *
 * Pular o passo 2 é o erro que custa caro: sem a chave anterior no ambiente,
 * o app não abre o que ainda não foi convertido, e o passo 4 não teria como
 * ler nada para converter.
 *
 * É seguro interromper e repetir: cada linha é lida com a chave que a abrir e
 * gravada com a atual, então rodar de novo termina o que faltou.
 */
const crypto = require('node:crypto');
const { PrismaClient } = require('@prisma/client');

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

function derivar(raw, nome) {
  if (!raw) throw new Error(`${nome} não está definida no ambiente`);
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  const b = Buffer.from(raw, 'base64');
  if (b.length === 32) return b;
  // Aceito para não travar quem ainda está numa frase antiga, mas avisado:
  // é justamente o formato que a rotação existe para deixar para trás.
  console.warn(`  aviso: ${nome} não é 32 bytes aleatórios; derivando por SHA-256`);
  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

function abrir(enc, iv, tag, key) {
  const d = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]);
}

function fechar(buf, key) {
  const iv = crypto.randomBytes(IV_BYTES);
  const c = crypto.createCipheriv(ALGORITHM, key, iv);
  const enc = Buffer.concat([c.update(buf), c.final()]);
  return {
    enc: enc.toString('base64'),
    iv: iv.toString('base64'),
    tag: c.getAuthTag().toString('base64'),
  };
}

/** Tenta a chave nova primeiro; devolve null quando nenhuma abre. */
function abrirComQualquer(enc, iv, tag, nova, antiga) {
  try {
    return { buf: abrir(enc, iv, tag, nova), jaEstavaNova: true };
  } catch {
    /* segue para a antiga */
  }
  try {
    return { buf: abrir(enc, iv, tag, antiga), jaEstavaNova: false };
  } catch {
    return null;
  }
}

async function main() {
  const aplicar = process.argv.includes('--apply');

  const nova = derivar(process.env.WALLET_ENCRYPTION_KEY, 'WALLET_ENCRYPTION_KEY');
  const antiga = derivar(
    process.env.WALLET_ENCRYPTION_KEY_PREVIOUS,
    'WALLET_ENCRYPTION_KEY_PREVIOUS',
  );

  if (nova.equals(antiga)) {
    throw new Error('a chave nova é igual à anterior — nada a rotacionar');
  }

  console.log(aplicar ? '\n═══ ROTAÇÃO (gravando) ═══\n' : '\n═══ ENSAIO (nada será gravado) ═══\n');

  const prisma = new PrismaClient();
  const resumo = { carteiras: 0, jaNovas: 0, convertidas: 0, ilegiveis: [], lojas: 0, lojasConv: 0 };

  try {
    const carteiras = await prisma.customerWallet.findMany({
      select: { id: true, publicKey: true, encryptedSecret: true, iv: true, authTag: true },
    });
    resumo.carteiras = carteiras.length;

    for (const w of carteiras) {
      const r = abrirComQualquer(w.encryptedSecret, w.iv, w.authTag, nova, antiga);
      if (!r) {
        resumo.ilegiveis.push(w.publicKey);
        continue;
      }
      if (r.jaEstavaNova) {
        resumo.jaNovas += 1;
        continue;
      }
      if (aplicar) {
        const s = fechar(r.buf, nova);
        await prisma.customerWallet.update({
          where: { id: w.id },
          data: { encryptedSecret: s.enc, iv: s.iv, authTag: s.tag, cipherVersion: 2 },
        });
      }
      resumo.convertidas += 1;
    }

    const lojas = await prisma.merchant.findMany({
      where: { aiKeyEnc: { not: null } },
      select: { id: true, name: true, aiKeyEnc: true, aiKeyIv: true, aiKeyTag: true },
    });
    resumo.lojas = lojas.length;

    for (const m of lojas) {
      const r = abrirComQualquer(m.aiKeyEnc, m.aiKeyIv, m.aiKeyTag, nova, antiga);
      if (!r || r.jaEstavaNova) continue;
      if (aplicar) {
        const s = fechar(r.buf, nova);
        await prisma.merchant.update({
          where: { id: m.id },
          data: { aiKeyEnc: s.enc, aiKeyIv: s.iv, aiKeyTag: s.tag },
        });
      }
      resumo.lojasConv += 1;
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log(`  carteiras encontradas .... ${resumo.carteiras}`);
  console.log(`  já na chave nova ......... ${resumo.jaNovas}`);
  console.log(`  ${aplicar ? 'convertidas' : 'a converter'} .......... ${resumo.convertidas}`);
  console.log(`  chaves de IA de lojas .... ${resumo.lojas} (${resumo.lojasConv} ${aplicar ? 'convertidas' : 'a converter'})`);

  if (resumo.ilegiveis.length > 0) {
    console.error(`\n  ATENÇÃO: ${resumo.ilegiveis.length} carteira(s) não abriram com NENHUMA das duas chaves:`);
    for (const pk of resumo.ilegiveis.slice(0, 10)) console.error(`    ${pk}`);
    console.error('  Confira se WALLET_ENCRYPTION_KEY_PREVIOUS é mesmo a chave com que elas foram gravadas.');
    console.error('  NÃO remova a chave anterior do ambiente enquanto isto não zerar.');
    process.exitCode = 1;
    return;
  }

  if (!aplicar) {
    console.log('\n  Ensaio limpo. Para aplicar:  npm run rotate:walletkey -- --apply');
  } else if (resumo.convertidas === 0 && resumo.lojasConv === 0) {
    console.log('\n  Nada restou na chave antiga. Já pode remover WALLET_ENCRYPTION_KEY_PREVIOUS.');
  } else {
    console.log('\n  Feito. Rode o ensaio de novo para confirmar que sobrou zero antes de');
    console.log('  remover WALLET_ENCRYPTION_KEY_PREVIOUS do ambiente.');
  }
}

main().catch((err) => {
  console.error(`\n  falhou: ${err.message}\n`);
  process.exit(1);
});
