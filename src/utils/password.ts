import crypto from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Hash de senha — uma implementação só, com custo versionado.
 *
 * Havia duas cópias disto no sistema (clientes e lojas), as duas chamando
 * `crypto.scrypt` sem parâmetros. Dois problemas nasciam daí:
 *
 *  • **o custo era o padrão do Node** (N=16384), calibrado há anos e barato
 *    para uma GPU de hoje. Quem roubasse o banco levaria as senhas fracas;
 *
 *  • **o formato guardado não dizia o custo usado.** `scrypt$sal$hash` não
 *    registra N, r nem p — então aumentar o custo depois quebraria TODAS as
 *    senhas existentes de uma vez, porque a verificação passaria a derivar
 *    com parâmetros diferentes dos da gravação. Na prática, isso trancava o
 *    custo no valor de 2019 para sempre.
 *
 * O formato novo carrega os parâmetros: `scrypt$N$r$p$sal$hash`. A verificação
 * aceita os dois, e quem entra com um hash antigo tem a senha re-gravada no
 * formato novo na hora — a base migra sozinha, sem ninguém perder acesso.
 *
 * Sobre a escolha de N: memória do scrypt é `128 * N * r`. Com N=65536 e r=8
 * dá ~67 MB por verificação. Em função serverless isso é caro mas cabe; subir
 * para o N=131072 que a OWASP prefere dobraria para 134 MB e algumas entradas
 * simultâneas estourariam a memória da função — uma indisponibilidade certa
 * trocada por uma margem teórica. O p=2 compensa parte disso em CPU, que é
 * barata aqui.
 */

const scryptAsync = promisify(crypto.scrypt) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>;

const KEY_LENGTH = 64;

/** Parâmetros de hoje. Mudar aqui só afeta senhas gravadas daqui em diante. */
export const SCRYPT_ATUAL = { N: 65_536, r: 8, p: 2 } as const;

/** Parâmetros implícitos dos hashes antigos: os padrões do Node. */
const SCRYPT_LEGADO = { N: 16_384, r: 8, p: 1 } as const;

function opcoes(p: { N: number; r: number; p: number }): crypto.ScryptOptions {
  return {
    N: p.N,
    r: p.r,
    p: p.p,
    // Sem isto o Node recusa qualquer N acima do padrão: o limite embutido é
    // de 32 MB, e 128*N*r já passa disso. A folga cobre o pico da alocação.
    maxmem: 256 * p.N * p.r + 8 * 1024 * 1024,
  };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const derived = await scryptAsync(password, salt, KEY_LENGTH, opcoes(SCRYPT_ATUAL));
  return [
    'scrypt',
    SCRYPT_ATUAL.N,
    SCRYPT_ATUAL.r,
    SCRYPT_ATUAL.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

export interface VerifyResult {
  ok: boolean;
  /** true quando o hash guardado usa parâmetros mais fracos que os de hoje. */
  needsUpgrade: boolean;
}

/**
 * Confere a senha aceitando o formato antigo e o novo.
 *
 * Comparação em tempo constante: uma senha errada e um formato inválido levam
 * o mesmo caminho e devolvem a mesma coisa. Diferença aqui vira oráculo.
 */
export async function verifyPassword(password: string, stored: string): Promise<VerifyResult> {
  const partes = String(stored ?? '').split('$');
  if (partes[0] !== 'scrypt') return { ok: false, needsUpgrade: false };

  let params: { N: number; r: number; p: number };
  let saltB64: string | undefined;
  let hashB64: string | undefined;
  let legado: boolean;

  if (partes.length === 3) {
    // scrypt$sal$hash — gravado antes de os parâmetros entrarem no formato.
    [, saltB64, hashB64] = partes;
    params = SCRYPT_LEGADO;
    legado = true;
  } else if (partes.length === 6) {
    const [, n, r, p, sal, hash] = partes;
    params = { N: Number(n), r: Number(r), p: Number(p) };
    saltB64 = sal;
    hashB64 = hash;
    legado = false;

    // Parâmetros vindos do banco são dados, não configuração: um valor
    // absurdo aqui viraria uma alocação de memória do tamanho que o atacante
    // escolhesse, e o processo cairia.
    const saoSanos =
      Number.isInteger(params.N) &&
      params.N >= 1024 &&
      params.N <= 1_048_576 &&
      (params.N & (params.N - 1)) === 0 &&
      Number.isInteger(params.r) &&
      params.r >= 1 &&
      params.r <= 32 &&
      Number.isInteger(params.p) &&
      params.p >= 1 &&
      params.p <= 16;
    if (!saoSanos) return { ok: false, needsUpgrade: false };
  } else {
    return { ok: false, needsUpgrade: false };
  }

  if (!saltB64 || !hashB64) return { ok: false, needsUpgrade: false };

  const expected = Buffer.from(hashB64, 'base64');
  if (expected.length === 0) return { ok: false, needsUpgrade: false };

  let derived: Buffer;
  try {
    derived = await scryptAsync(
      password,
      Buffer.from(saltB64, 'base64'),
      expected.length,
      opcoes(params),
    );
  } catch {
    return { ok: false, needsUpgrade: false };
  }

  const ok = derived.length === expected.length && crypto.timingSafeEqual(derived, expected);

  const maisFraco =
    legado ||
    params.N < SCRYPT_ATUAL.N ||
    params.r < SCRYPT_ATUAL.r ||
    params.p < SCRYPT_ATUAL.p;

  return { ok, needsUpgrade: ok && maisFraco };
}

/**
 * Trabalho equivalente ao de uma verificação real, para o tempo de resposta
 * não denunciar que a conta não existe.
 */
export async function dummyVerify(password: string): Promise<void> {
  await scryptAsync(password ?? '', crypto.randomBytes(16), KEY_LENGTH, opcoes(SCRYPT_ATUAL));
}
