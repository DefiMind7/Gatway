import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { Prisma, type Customer, type CustomerWallet } from '@prisma/client';
import { config, LAMPORTS_PER_SOL } from '../config';
import { prisma } from '../database/client';
import { DepositIntentStatus, GatewayError, OrderStatus } from '../types';
import { logger } from '../utils/logger';
import { getBalance } from './solana.service';
import { createWallet } from './wallet.service';

/**
 * Contas de cliente.
 *
 * O ponto do cadastro é a carteira: ela nasce aqui, uma vez, e recebe TODAS as
 * compras daquela pessoa. Sem conta, cada depósito criaria um endereço novo e
 * o cliente acabaria com o dinheiro espalhado por carteiras que ele nem sabe
 * que existem.
 *
 * Autenticação é e-mail + senha, deliberadamente simples: sem verificação por
 * e-mail (exigiria provedor de envio), sem OAuth, sem recuperação automática.
 * Para um teste fechado isso é adequado; o que NÃO é opcional é a senha nunca
 * existir em claro e a sessão ser revogável.
 */

const log = logger.child({ scope: 'customer' });

const scrypt = promisify(crypto.scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const SESSION_DAYS = 30;
const KEY_LENGTH = 64;

// ─────────────────────────── Senha ───────────────────────────

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
}

/**
 * Compara em tempo constante. Uma senha errada e um formato inválido levam o
 * mesmo tempo e devolvem a mesma coisa — diferença aqui vira oráculo.
 */
async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;

  const expected = Buffer.from(hashB64, 'base64');
  const derived = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length);
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

// ─────────────────────────── Sessão ───────────────────────────

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function issueSession(customerId: string, clientIp?: string | undefined): Promise<string> {
  const token = crypto.randomBytes(32).toString('base64url');

  await prisma.customerSession.create({
    data: {
      tokenHash: hashToken(token),
      customerId,
      expiresAt: new Date(Date.now() + SESSION_DAYS * 24 * 3_600_000),
      ...(clientIp !== undefined ? { clientIp } : {}),
    },
  });

  return token;
}

export interface AuthenticatedCustomer {
  customer: Customer;
  wallet: CustomerWallet;
}

/** Resolve o token de sessão. Devolve null em qualquer falha — sem detalhes. */
export async function authenticate(token: string): Promise<AuthenticatedCustomer | null> {
  if (!token) return null;

  const session = await prisma.customerSession.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { customer: { include: { wallet: true } } },
  });

  if (!session) return null;
  if (session.expiresAt.getTime() < Date.now()) {
    // Higiene: sessão vencida sai da tabela na primeira vez que aparece.
    await prisma.customerSession.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }

  return { customer: session.customer, wallet: session.customer.wallet };
}

export async function logout(token: string): Promise<void> {
  if (!token) return;
  await prisma.customerSession
    .delete({ where: { tokenHash: hashToken(token) } })
    .catch(() => undefined);
}

// ─────────────────────────── Cadastro e login ───────────────────────────

function normalizeEmail(raw: unknown): string {
  const email = String(raw ?? '').trim().toLowerCase();
  // Validação proposital de baixa ambição: e-mail só é verificado de verdade
  // mandando mensagem para ele, e isso não existe aqui. O formato serve para
  // pegar erro de digitação, não para provar posse.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) {
    throw new GatewayError('e-mail inválido', 'INVALID_EMAIL', false);
  }
  return email;
}

function assertPasswordStrength(password: string): void {
  if (typeof password !== 'string' || password.length < 8) {
    throw new GatewayError('a senha precisa de ao menos 8 caracteres', 'WEAK_PASSWORD', false);
  }
  if (password.length > 200) {
    throw new GatewayError('senha longa demais', 'WEAK_PASSWORD', false);
  }
}

export interface AuthResult {
  token: string;
  email: string;
  walletAddress: string;
  createdAt: string;
}

/**
 * Cria a conta e a carteira no mesmo instante.
 *
 * A carteira vem primeiro e a conta depois, numa transação: se a criação da
 * conta falhar (e-mail duplicado, por exemplo), a carteira órfã é apagada. O
 * contrário — conta sem carteira — deixaria um cliente sem destino para o
 * dinheiro dele.
 */
export async function register(input: {
  email: unknown;
  password: string;
  clientIp?: string | undefined;
}): Promise<AuthResult> {
  const email = normalizeEmail(input.email);
  assertPasswordStrength(input.password);

  if (!config.wallet.enabled) {
    throw new GatewayError(
      'cadastro indisponível: geração de carteiras está desligada',
      'WALLET_GENERATION_DISABLED',
      false,
    );
  }

  const existing = await prisma.customer.findUnique({ where: { email } });
  if (existing) {
    throw new GatewayError('já existe uma conta com este e-mail', 'EMAIL_TAKEN', false);
  }

  const passwordHash = await hashPassword(input.password);
  const wallet = await createWallet(input.clientIp);

  let customer: Customer;
  try {
    customer = await prisma.customer.create({
      data: {
        email,
        passwordHash,
        walletId: wallet.id,
        ...(input.clientIp !== undefined ? { clientIp: input.clientIp } : {}),
      },
    });
  } catch (err) {
    await prisma.customerWallet.delete({ where: { id: wallet.id } }).catch(() => undefined);
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new GatewayError('já existe uma conta com este e-mail', 'EMAIL_TAKEN', false);
    }
    throw err;
  }

  log.info({ email, wallet: wallet.publicKey }, 'conta criada com carteira');

  return {
    token: await issueSession(customer.id, input.clientIp),
    email,
    walletAddress: wallet.publicKey,
    createdAt: customer.createdAt.toISOString(),
  };
}

export async function login(input: {
  email: unknown;
  password: string;
  clientIp?: string | undefined;
}): Promise<AuthResult> {
  const email = normalizeEmail(input.email);

  const customer = await prisma.customer.findUnique({
    where: { email },
    include: { wallet: true },
  });

  // Mesma mensagem para "não existe" e "senha errada": distinguir os dois
  // entrega uma lista de e-mails cadastrados a quem quiser montá-la.
  const invalid = new GatewayError('e-mail ou senha incorretos', 'INVALID_CREDENTIALS', false);
  if (!customer) {
    // Trabalho equivalente ao de uma verificação real, para o tempo de
    // resposta não denunciar a existência da conta.
    await hashPassword(input.password ?? '');
    throw invalid;
  }
  if (!(await verifyPassword(String(input.password ?? ''), customer.passwordHash))) {
    throw invalid;
  }

  await prisma.customer.update({
    where: { id: customer.id },
    data: { lastLoginAt: new Date() },
  });

  return {
    token: await issueSession(customer.id, input.clientIp),
    email,
    walletAddress: customer.wallet.publicKey,
    createdAt: customer.createdAt.toISOString(),
  };
}

// ─────────────────────────── Visão da conta ───────────────────────────

export interface AccountView {
  email: string;
  wallet: {
    address: string;
    /** Saldo real lido da chain. Null quando o RPC não respondeu. */
    solBalance: number | null;
    /** Já pediu a chave privada alguma vez. */
    keyExported: boolean;
  };
  totals: {
    /** SOL já entregue nesta conta, somando as ordens liquidadas. */
    solReceived: number;
    deposits: number;
  };
  /**
   * Extrato: só o que moveu dinheiro.
   *
   * Uma intenção criada e nunca paga não é transação — é um formulário
   * preenchido. Listá-la enche o extrato de linhas "aguardando" que nunca vão
   * a lugar nenhum e escondem as que importam.
   */
  history: Array<{
    type: 'deposit' | 'withdrawal';
    reference: string | null;
    /** O que o cliente pagou (depósito) ou o destino (envio). */
    description: string;
    /** Positivo em depósito, negativo em envio. Null enquanto não entregue. */
    solAmount: number | null;
    /** `concluido`, `processando` ou `falhou`. */
    state: 'concluido' | 'processando' | 'falhou';
    signature: string | null;
    at: string;
  }>;
}

/**
 * Tudo que a tela "minha conta" mostra.
 *
 * O saldo vem da CHAIN, não de um número guardado por nós: saldo em banco de
 * dados de custodiante é uma promessa; o da chain é o dinheiro.
 */
export async function getAccountView(auth: AuthenticatedCustomer): Promise<AccountView> {
  const { customer, wallet } = auth;

  const [balance, intents, orders, withdrawals] = await Promise.all([
    getBalance(new (await import('@solana/web3.js')).PublicKey(wallet.publicKey)).catch(() => null),
    // Só depósitos que o cliente realmente pagou.
    prisma.depositIntent.findMany({
      where: { customerId: customer.id, status: DepositIntentStatus.CONFIRMED },
      orderBy: { createdAt: 'desc' },
      take: 25,
    }),
    prisma.order.findMany({
      where: { customerWallet: wallet.publicKey },
      select: {
        id: true,
        status: true,
        customerLamports: true,
        customerPayoutSignature: true,
      },
    }),
    prisma.withdrawal.findMany({
      where: { customerId: customer.id },
      orderBy: { createdAt: 'desc' },
      take: 25,
    }),
  ]);

  const byId = new Map(orders.map((o) => [o.id, o]));

  const solReceived = orders
    .filter((o) => o.status === OrderStatus.SETTLED || o.status === OrderStatus.DISTRIBUTED)
    .reduce((acc, o) => acc + Number(o.customerLamports ?? 0n), 0) / LAMPORTS_PER_SOL;

  type Entry = AccountView['history'][number];

  const deposits: Entry[] = intents.map((i) => {
    const order = i.orderId === null ? null : (byId.get(i.orderId) ?? null);
    const delivered =
      order?.status === OrderStatus.SETTLED || order?.status === OrderStatus.DISTRIBUTED;

    return {
      type: 'deposit',
      reference: i.reference,
      description: `Depósito de ${i.fiatAmount.toString()} ${i.fiatCurrency}`,
      solAmount:
        order?.customerLamports == null ? null : Number(order.customerLamports) / LAMPORTS_PER_SOL,
      state: delivered ? 'concluido' : order?.status === OrderStatus.FAILED ? 'falhou' : 'processando',
      signature: order?.customerPayoutSignature ?? null,
      at: i.createdAt.toISOString(),
    };
  });

  const sends: Entry[] = withdrawals.map((w) => ({
    type: 'withdrawal',
    reference: null,
    description: `Envio para ${w.destination.slice(0, 4)}…${w.destination.slice(-4)}`,
    // Negativo: saiu da carteira.
    solAmount: -(Number(w.lamports) / LAMPORTS_PER_SOL),
    state: w.status === 'SENT' && w.signature !== null ? 'concluido' : 'falhou',
    signature: w.signature,
    at: w.createdAt.toISOString(),
  }));

  const history = [...deposits, ...sends]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 30);

  return {
    email: customer.email,
    wallet: {
      address: wallet.publicKey,
      solBalance: balance === null ? null : Number(balance) / LAMPORTS_PER_SOL,
      keyExported: wallet.revealedAt !== null,
    },
    totals: {
      solReceived,
      deposits: intents.length,
    },
    history,
  };
}

/** Contagem para o painel do operador. */
export async function customerStats(): Promise<{ total: number; withDeposits: number }> {
  const [total, withDeposits] = await Promise.all([
    prisma.customer.count(),
    prisma.customer.count({ where: { intents: { some: {} } } }),
  ]);
  return { total, withDeposits };
}
