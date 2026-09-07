import { Router, type NextFunction, type Request, type Response } from 'express';
import type { Merchant } from '@prisma/client';
import { config } from '../config';
import { prisma } from '../database/client';
import { GatewayError } from '../types';
import { logger } from '../utils/logger';
import { createIntent, getCheckoutOptions } from '../services/deposit.service';
import {
  assertHttpsUrl,
  authenticateMerchant,
  toChargeView,
} from '../services/merchant.service';
import { submitApplication } from '../services/application.service';
import { ah } from '../utils/async-route';

/**
 * API pública para lojas — `/api/v1`.
 *
 * O contrato é o mínimo que uma integração precisa e nada além: criar
 * cobrança, consultar cobrança, listar cobranças. Quanto menor a superfície,
 * menos coisa quebra do lado da loja quando isto evoluir.
 *
 * A cobrança criada aqui é uma `DepositIntent` como qualquer outra — Pix,
 * cartão, retenção, fila de entrega e livro-razão funcionam sem saber que a
 * origem foi uma loja.
 */

const router: Router = Router();
const log = logger.child({ scope: 'api.v1' });

/** Requisição já autenticada como loja. */
interface MerchantRequest extends Request {
  merchant?: Merchant;
}

async function requireMerchant(
  req: MerchantRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.headers.authorization;
  const key = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';

  const merchant = await authenticateMerchant(key);
  if (!merchant) {
    // Sem detalhe: dizer "chave inválida" vs "loja desativada" ajuda quem está
    // testando chaves, não quem está integrando de verdade.
    res.status(401).json({
      error: 'unauthorized',
      message: 'chave de API inválida ou inativa. Envie em Authorization: Bearer sk_live_…',
    });
    return;
  }

  req.merchant = merchant;
  next();
}

/**
 * Candidatura de loja — o único endpoint público desta API.
 *
 * Fica ANTES do middleware de autenticação de propósito: quem se candidata
 * ainda não tem chave, e é justamente isso que está pedindo.
 */
router.post('/applications', ah(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, string | undefined>;

  const pedido = await submitApplication({
    companyName: String(body.companyName ?? ''),
    email: String(body.email ?? ''),
    legalName: body.legalName,
    taxId: body.taxId,
    phone: body.phone,
    website: body.website,
    callbackUrl: body.callbackUrl,
    expectedVolume: body.expectedVolume,
    description: body.description,
    clientIp: req.ip,
  });

  // Devolve o mínimo: id para referência e o e-mail para a tela confirmar.
  res.status(201).json({
    id: pedido.id,
    status: pedido.status,
    email: pedido.email,
    message: 'Pedido recebido. A resposta vai por e-mail.',
  });
}));

router.use(ah(requireMerchant as never));

// ─────────────────────────── Cobranças ───────────────────────────

/**
 * Cria uma cobrança e devolve o link do checkout.
 *
 * A loja manda o cliente dela para `checkoutUrl`. O valor e a moeda são
 * validados contra os limites do gateway — uma loja não consegue criar
 * cobrança fora da faixa configurada.
 */
router.post('/charges', ah(async (req: MerchantRequest, res: Response) => {
  const merchant = req.merchant!;
  const body = (req.body ?? {}) as {
    amount?: number;
    currency?: string;
    method?: string;
    externalId?: string;
    destinationWallet?: string;
    customerEmail?: string;
    callbackUrl?: string;
    returnUrl?: string;
  };

  if (typeof body.amount !== 'number' || !Number.isFinite(body.amount)) {
    throw new GatewayError('amount é obrigatório e precisa ser número', 'INVALID_BODY', false);
  }
  if (body.callbackUrl) assertHttpsUrl(body.callbackUrl, 'callbackUrl');
  if (body.returnUrl) assertHttpsUrl(body.returnUrl, 'returnUrl');

  const { intent } = await createIntent({
    method: body.method ?? 'PIXQR',
    currency: body.currency ?? 'BRL',
    amount: body.amount,
    customerWallet: body.destinationWallet,
    customerEmail: body.customerEmail ?? merchant.email,
    clientIp: req.ip,
  });

  // Vínculo com a loja depois da criação: `createIntent` é o mesmo caminho do
  // checkout próprio e não conhece o conceito de loja.
  const linked = await prisma.depositIntent.update({
    where: { id: intent.id },
    data: {
      merchantId: merchant.id,
      ...(body.externalId !== undefined ? { merchantExternalId: String(body.externalId) } : {}),
      ...(body.callbackUrl !== undefined ? { merchantCallbackUrl: body.callbackUrl } : {}),
      ...(body.returnUrl !== undefined ? { merchantReturnUrl: body.returnUrl } : {}),
    },
  });

  log.info(
    { merchantId: merchant.id, reference: linked.reference, amount: body.amount },
    'cobrança criada por loja',
  );

  res.status(201).json(toChargeView(linked, null));
}));

/** Estado de uma cobrança. É o que a loja consulta se perder o webhook. */
router.get('/charges/:id', ah(async (req: MerchantRequest, res: Response) => {
  const merchant = req.merchant!;
  const id = String(req.params.id ?? '').trim().toUpperCase();

  const intent = await prisma.depositIntent.findUnique({ where: { reference: id } });
  // Mesma resposta para "não existe" e "é de outra loja": confirmar a
  // existência de uma referência alheia já é informação demais.
  if (!intent || intent.merchantId !== merchant.id) {
    return res.status(404).json({ error: 'not_found', message: 'cobrança não encontrada' });
  }

  const order =
    intent.orderId === null
      ? null
      : await prisma.order.findUnique({
          where: { id: intent.orderId },
          select: { status: true, customerLamports: true, customerPayoutSignature: true },
        });

  return res.json(toChargeView(intent, order));
}));

router.get('/charges', ah(async (req: MerchantRequest, res: Response) => {
  const merchant = req.merchant!;
  const limit = Math.min(Math.max(Number(req.query.limit ?? 25), 1), 100);

  const intents = await prisma.depositIntent.findMany({
    where: { merchantId: merchant.id },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  const orderIds = intents.map((i) => i.orderId).filter((id): id is string => id !== null);
  const orders =
    orderIds.length === 0
      ? []
      : await prisma.order.findMany({
          where: { id: { in: orderIds } },
          select: {
            id: true,
            status: true,
            customerLamports: true,
            customerPayoutSignature: true,
          },
        });
  const byId = new Map(orders.map((o) => [o.id, o]));

  res.json({
    charges: intents.map((i) => toChargeView(i, i.orderId ? (byId.get(i.orderId) ?? null) : null)),
  });
}));

/** Limites e trilhos aceitos — a loja usa para validar antes de cobrar. */
router.get('/config', ah(async (req: MerchantRequest, res: Response) => {
  const options = await getCheckoutOptions();
  res.json({
    merchant: { name: req.merchant!.name },
    methods: options.methods.map((m) => ({
      method: m.method,
      label: m.label,
      currencies: m.currencies,
    })),
    minAmount: options.minAmount,
    maxAmount: options.maxAmount,
    checkoutExpiresInMinutes: options.ttlMinutes,
    baseUrl: config.mercadopago.publicBaseUrl || null,
  });
}));

export default router;
