import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import type { Merchant } from '@prisma/client';
import { PublicKey } from '@solana/web3.js';
import { prisma } from '../database/client';
import { GatewayError } from '../types';
import { logger } from '../utils/logger';
import {
  getBalance,
  getLedger,
  listWithdrawals,
  requestWithdrawal,
  verifyMerchantPassword,
} from '../services/merchant-ledger.service';
import { MERCHANT_PAGE_HTML } from './merchant.page';
import { ah } from '../utils/async-route';

/**
 * Portal da loja — `/loja`.
 *
 * É onde o dono da loja acompanha o faturamento e pede o saque. Separado do
 * painel do operador de propósito: são pessoas diferentes, com poderes
 * diferentes, e misturar as duas telas seria a forma mais rápida de dar a uma
 * loja acesso ao que não é dela.
 *
 * A autenticação é por sessão, não pela chave de API: a chave é do servidor da
 * loja e vive em configuração; o portal é do humano e vive no navegador. Usar
 * a mesma credencial para os dois significaria que qualquer pessoa com acesso
 * ao código da loja poderia sacar o dinheiro dela.
 */

const router: Router = Router();
const log = logger.child({ scope: 'merchant.portal' });

const SESSION_DAYS = 14;

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function autenticar(req: Request): Promise<Merchant | null> {
  const header = req.headers['x-merchant-session'];
  const token = typeof header === 'string' ? header : '';
  if (!token) return null;

  const sessao = await prisma.merchantSession.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { merchant: true },
  });

  if (!sessao) return null;
  if (sessao.expiresAt.getTime() < Date.now()) {
    await prisma.merchantSession.delete({ where: { id: sessao.id } }).catch(() => undefined);
    return null;
  }
  if (!sessao.merchant.active) return null;

  return sessao.merchant;
}

async function exigirLoja(req: Request): Promise<Merchant> {
  const loja = await autenticar(req);
  if (!loja) throw new GatewayError('faça login para continuar', 'UNAUTHENTICATED', false);
  return loja;
}

/** A página em si é estática; o estado vem de /loja/api/*. */
router.get('/', (_req: Request, res: Response) => {
  res.type('html').send(MERCHANT_PAGE_HTML);
});

// ─────────────────────────── Sessão ───────────────────────────

router.post('/api/login', ah(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { email?: string; password?: string };
  const email = String(body.email ?? '').trim().toLowerCase();
  const senha = String(body.password ?? '');

  const loja = await prisma.merchant.findFirst({ where: { email } });

  // Mesma resposta para loja inexistente, senha errada e loja sem portal:
  // distinguir os casos entrega um mapa de quem existe.
  const invalido = new GatewayError('e-mail ou senha incorretos', 'INVALID_CREDENTIALS', false);
  if (!loja || !loja.passwordHash || !loja.active) throw invalido;
  if (!(await verifyMerchantPassword(senha, loja.passwordHash))) throw invalido;

  const token = crypto.randomBytes(32).toString('base64url');
  await prisma.merchantSession.create({
    data: {
      tokenHash: hashToken(token),
      merchantId: loja.id,
      expiresAt: new Date(Date.now() + SESSION_DAYS * 24 * 3_600_000),
      ...(req.ip !== undefined ? { clientIp: req.ip } : {}),
    },
  });

  log.info({ merchantId: loja.id }, 'loja entrou no portal');
  res.json({ token, name: loja.name, email: loja.email });
}));

router.post('/api/logout', ah(async (req: Request, res: Response) => {
  const header = req.headers['x-merchant-session'];
  if (typeof header === 'string' && header) {
    await prisma.merchantSession
      .delete({ where: { tokenHash: hashToken(header) } })
      .catch(() => undefined);
  }
  res.json({ ok: true });
}));

// ─────────────────────────── Painel da loja ───────────────────────────

/** Faturamento, saldo e as últimas vendas. */
router.get('/api/dashboard', ah(async (req: Request, res: Response) => {
  const loja = await exigirLoja(req);

  const [saldo, extrato, saques, vendas] = await Promise.all([
    getBalance(loja.id),
    getLedger(loja.id, 30),
    listWithdrawals({ merchantId: loja.id, limit: 20 }),
    prisma.depositIntent.findMany({
      where: { merchantId: loja.id },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: {
        reference: true,
        status: true,
        fiatAmount: true,
        fiatCurrency: true,
        merchantExternalId: true,
        createdAt: true,
        confirmedAt: true,
      },
    }),
  ]);

  res.json({
    merchant: {
      name: loja.name,
      email: loja.email,
      payoutWallet: loja.payoutWallet,
      commissionBps: loja.commissionBps,
      apiKeyPrefix: loja.apiKeyPrefix,
      callbackUrl: loja.callbackUrl,
    },
    balance: saldo,
    ledger: extrato,
    withdrawals: saques.map((s) => ({
      id: s.id,
      amount: s.amountFiat,
      status: s.status,
      wallet: s.destinationWallet,
      solSent: s.solSent,
      signature: s.signature,
      note: s.reviewNote,
      createdAt: s.createdAt,
    })),
    sales: vendas.map((v) => ({
      reference: v.reference,
      status: v.status,
      amount: `${v.fiatAmount.toString()} ${v.fiatCurrency}`,
      externalId: v.merchantExternalId,
      createdAt: v.createdAt.toISOString(),
      paidAt: v.confirmedAt?.toISOString() ?? null,
    })),
  });
}));

/** A loja define onde quer receber os saques. */
router.post('/api/wallet', ah(async (req: Request, res: Response) => {
  const loja = await exigirLoja(req);
  const body = (req.body ?? {}) as { wallet?: string };
  const carteira = String(body.wallet ?? '').trim();

  try {
    new PublicKey(carteira);
  } catch {
    throw new GatewayError(`carteira Solana inválida: "${carteira}"`, 'INVALID_WALLET', false);
  }

  await prisma.merchant.update({ where: { id: loja.id }, data: { payoutWallet: carteira } });
  log.info({ merchantId: loja.id }, 'loja atualizou a carteira de saque');
  res.json({ ok: true, wallet: carteira });
}));

/**
 * Pedido de saque.
 *
 * O valor sai do saldo no ato do pedido — ver `requestWithdrawal`. A conversão
 * para SOL acontece só na aprovação do operador, pela cotação daquele momento.
 */
router.post('/api/withdrawals', ah(async (req: Request, res: Response) => {
  const loja = await exigirLoja(req);
  const body = (req.body ?? {}) as { amount?: number; wallet?: string };

  const resultado = await requestWithdrawal({
    merchant: loja,
    amountFiat: Number(body.amount),
    destinationWallet: body.wallet,
    clientIp: req.ip,
  });

  res.status(201).json(resultado);
}));

export default router;
