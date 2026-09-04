import crypto from 'node:crypto';
import type { CustomerWallet } from '@prisma/client';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { config } from '../config';
import { prisma } from '../database/client';
import { GatewayError } from '../types';
import { logger } from '../utils/logger';

/**
 * Carteiras geradas para clientes que não têm uma.
 *
 * Existe para tirar do caminho a maior fricção do checkout: pedir a alguém que
 * nunca usou cripto que cole um endereço Solana. Aqui o cliente paga e pronto —
 * a carteira é criada no ato e o SOL cai nela.
 *
 * O preço disso é ser CUSTODIANTE. Enquanto o cliente não pedir a chave, o
 * dinheiro é dele e a chave é nossa; um vazamento do banco seria um roubo de
 * fundos de terceiros. Por isso:
 *
 *  • a chave privada é cifrada com AES-256-GCM antes de tocar o banco;
 *  • a chave de cifra vive só em `WALLET_ENCRYPTION_KEY`, fora do banco — as
 *    duas metades precisam vazar juntas para o dano acontecer;
 *  • GCM (e não CBC) porque a tag de autenticação impede que alguém com acesso
 *    de escrita ao banco altere o texto cifrado sem ser detectado;
 *  • IV aleatório por carteira: reusar nonce em GCM quebra a cifra inteira, não
 *    só aquele registro.
 *
 * O que este módulo nunca faz: gravar, logar ou devolver a chave privada em
 * claro fora de `revealSecret`.
 */

const log = logger.child({ scope: 'wallet' });

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // recomendado para GCM
const CIPHER_VERSION = 1;

/** Deriva a chave de 32 bytes do env, aceitando hex, base64 ou frase longa. */
function encryptionKey(): Buffer {
  const raw = config.wallet.encryptionKey;
  if (!raw) {
    throw new GatewayError(
      'WALLET_ENCRYPTION_KEY não configurada — carteiras geradas estão desabilitadas',
      'WALLET_KEY_MISSING',
      false,
    );
  }

  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');

  const decoded = Buffer.from(raw, 'base64');
  if (decoded.length === 32) return decoded;

  // Última opção: frase. O hash dá 32 bytes, mas a entropia continua sendo a
  // da frase — por isso o config exige comprimento mínimo.
  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

interface Sealed {
  encryptedSecret: string;
  iv: string;
  authTag: string;
}

function seal(secret: Uint8Array): Sealed {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(secret)), cipher.final()]);
  return {
    encryptedSecret: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

function open(wallet: Pick<CustomerWallet, 'encryptedSecret' | 'iv' | 'authTag'>): Uint8Array {
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    encryptionKey(),
    Buffer.from(wallet.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(wallet.authTag, 'base64'));
  try {
    return Uint8Array.from(
      Buffer.concat([
        decipher.update(Buffer.from(wallet.encryptedSecret, 'base64')),
        decipher.final(),
      ]),
    );
  } catch {
    // Falha de tag = chave de cifra errada ou registro adulterado. Não há
    // caminho de recuperação, e mascarar isso seria pior do que gritar.
    throw new GatewayError(
      'não foi possível decifrar a carteira: WALLET_ENCRYPTION_KEY mudou ou o registro foi alterado',
      'WALLET_DECRYPT_FAILED',
      false,
    );
  }
}

/** Gera uma carteira nova e guarda a chave cifrada. Devolve só o endereço. */
export async function createWallet(clientIp?: string | undefined): Promise<CustomerWallet> {
  if (!config.wallet.enabled) {
    throw new GatewayError(
      'geração de carteiras desabilitada (WALLET_GENERATION=false)',
      'WALLET_GENERATION_DISABLED',
      false,
    );
  }

  const keypair = Keypair.generate();
  const sealed = seal(keypair.secretKey);

  const wallet = await prisma.customerWallet.create({
    data: {
      publicKey: keypair.publicKey.toBase58(),
      ...sealed,
      cipherVersion: CIPHER_VERSION,
      ...(clientIp !== undefined ? { clientIp } : {}),
    },
  });

  log.info({ publicKey: wallet.publicKey }, 'carteira gerada para cliente');
  return wallet;
}

export interface RevealedSecret {
  publicKey: string;
  /** Formato base58 — é o que Phantom, Solflare e Backpack importam. */
  secretKeyBase58: string;
  /** Formato array de 64 bytes — é o que a CLI da Solana espera. */
  secretKeyArray: number[];
  /** true na primeira vez; depois disso o cliente já viu esta chave. */
  firstReveal: boolean;
}

/**
 * Entrega a chave privada ao cliente.
 *
 * A partir daqui a carteira deixa de ser custodiada de fato — quem tem a chave
 * move o dinheiro, e nós continuamos com uma cópia. É por isso que a revelação
 * fica registrada com data: sem esse rastro, "o cliente tinha a chave?" vira
 * uma discussão sem resposta no dia em que algo sumir.
 *
 * A operação é deixada explícita e única de propósito: o cliente pede, vê uma
 * vez, e é avisado para guardar.
 */
export async function revealSecret(walletId: string): Promise<RevealedSecret> {
  const wallet = await prisma.customerWallet.findUnique({ where: { id: walletId } });
  if (!wallet) {
    throw new GatewayError('carteira não encontrada', 'WALLET_NOT_FOUND', false);
  }

  const secret = open(wallet);
  const firstReveal = wallet.revealedAt === null;

  if (firstReveal) {
    await prisma.customerWallet.update({
      where: { id: wallet.id },
      data: { revealedAt: new Date() },
    });
    log.warn({ publicKey: wallet.publicKey }, 'chave privada entregue ao cliente');
  }

  return {
    publicKey: wallet.publicKey,
    secretKeyBase58: bs58.encode(secret),
    secretKeyArray: Array.from(secret),
    firstReveal,
  };
}

/**
 * Devolve a keypair para ASSINAR em nome do cliente (saque).
 *
 * Diferente de `revealSecret`, isto não entrega nada ao cliente nem marca a
 * carteira como revelada: a chave é decifrada, usada em memória para assinar,
 * e descartada. É o mínimo de custódia necessário para o saque existir.
 */
export async function loadKeypair(walletId: string): Promise<Keypair> {
  const wallet = await prisma.customerWallet.findUnique({ where: { id: walletId } });
  if (!wallet) {
    throw new GatewayError('carteira não encontrada', 'WALLET_NOT_FOUND', false);
  }

  const keypair = Keypair.fromSecretKey(open(wallet));
  if (keypair.publicKey.toBase58() !== wallet.publicKey) {
    throw new GatewayError(
      'a chave decifrada não corresponde ao endereço gravado',
      'WALLET_MISMATCH',
      false,
    );
  }
  return keypair;
}

/**
 * Confere, no boot, que a chave de cifra abre as carteiras que já existem.
 *
 * Descobrir que `WALLET_ENCRYPTION_KEY` foi trocada no momento em que um
 * cliente pede a chave dele é tarde demais: nesse ponto o dinheiro já está
 * inacessível. Melhor falhar barulhento na subida.
 */
export async function assertWalletsReadable(): Promise<{ checked: number }> {
  if (!config.wallet.enabled) return { checked: 0 };

  const sample = await prisma.customerWallet.findMany({
    orderBy: { createdAt: 'desc' },
    take: 3,
  });

  for (const wallet of sample) {
    const secret = open(wallet);
    const derived = Keypair.fromSecretKey(secret).publicKey.toBase58();
    if (derived !== wallet.publicKey) {
      throw new GatewayError(
        `carteira ${wallet.publicKey} decifra para outra chave (${derived}) — banco inconsistente`,
        'WALLET_MISMATCH',
        false,
      );
    }
  }

  return { checked: sample.length };
}

/** Quantas carteiras custodiadas existem e quantas já foram entregues. */
export async function walletStats(): Promise<{ total: number; revealed: number }> {
  const [total, revealed] = await Promise.all([
    prisma.customerWallet.count(),
    prisma.customerWallet.count({ where: { revealedAt: { not: null } } }),
  ]);
  return { total, revealed };
}
