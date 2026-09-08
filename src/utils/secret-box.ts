import crypto from 'node:crypto';
import { config } from '../config';
import { GatewayError } from '../types';

/**
 * Cofre genérico para segredos de terceiros guardados por nós.
 *
 * Mesmo esquema da custódia de carteiras — AES-256-GCM com a chave em
 * `WALLET_ENCRYPTION_KEY`, fora do banco — mas em módulo próprio e sem tocar
 * em `wallet.service`. A duplicação de umas dez linhas é deliberada: aquele
 * arquivo guarda chaves privadas que movem dinheiro, e refatorá-lo para
 * acomodar um caso novo é o tipo de mudança cujo erro só aparece quando um
 * saque falha.
 *
 * Usado hoje para a chave da API da Anthropic que cada loja traz. Ela não move
 * dinheiro nosso, mas gasta o dela — e um dump do banco não pode virar conta
 * na fatura de ninguém.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // recomendado para GCM

function derivar(raw: string): Buffer {
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');

  const decoded = Buffer.from(raw, 'base64');
  if (decoded.length === 32) return decoded;

  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

/** Deriva a chave de 32 bytes do env, aceitando hex, base64 ou frase longa. */
function chave(): Buffer {
  const raw = config.wallet.encryptionKey;
  if (!raw) {
    throw new GatewayError(
      'WALLET_ENCRYPTION_KEY não configurada — não há onde guardar segredos com segurança',
      'ENCRYPTION_KEY_MISSING',
      false,
    );
  }

  return derivar(raw);
}

/** A chave anterior, quando existe. Só para LER durante uma rotação. */
function chaveAnterior(): Buffer | null {
  const raw = config.wallet.previousEncryptionKey;
  return raw ? derivar(raw) : null;
}

export interface Sealed {
  enc: string;
  iv: string;
  tag: string;
}

export function seal(texto: string): Sealed {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, chave(), iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(texto, 'utf8')), cipher.final()]);
  return {
    enc: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

function abrirCom(sealed: Sealed, k: Buffer): string {
  const decipher = crypto.createDecipheriv(ALGORITHM, k, Buffer.from(sealed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.enc, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Abre com a chave atual; se falhar, tenta a anterior.
 *
 * A tag do GCM torna essa tentativa segura: ela não "quase abre" com a chave
 * errada, ou autentica ou lança. Não há oráculo aqui — só duas chaves nossas.
 */
export function open(sealed: Sealed): string {
  try {
    return abrirCom(sealed, chave());
  } catch {
    const anterior = chaveAnterior();
    if (anterior) {
      try {
        return abrirCom(sealed, anterior);
      } catch {
        /* cai no erro comum abaixo */
      }
    }
    // A tag do GCM não fecha: ou a chave mudou, ou a linha foi adulterada.
    // Os dois casos exigem intervenção humana e nenhum admite adivinhação.
    throw new GatewayError(
      'não foi possível decifrar o segredo: WALLET_ENCRYPTION_KEY mudou ou o registro foi alterado',
      'DECRYPT_FAILED',
      false,
    );
  }
}
