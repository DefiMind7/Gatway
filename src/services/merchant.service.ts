import crypto from 'node:crypto';
import axios from 'axios';
import type { DepositIntent, Merchant } from '@prisma/client';
import { config, LAMPORTS_PER_SOL } from '../config';
import { prisma } from '../database/client';
import { DepositIntentStatus, GatewayError, OrderStatus } from '../types';
import { logger } from '../utils/logger';

/**
 * Lojas integradas — o gateway como meio de pagamento de terceiros.
 *
 * A loja cria uma cobrança pela API, manda o cliente dela para o checkout
 * hospedado, e recebe um webhook quando o dinheiro entra. Do lado de cá, a
 * cobrança vira uma `DepositIntent` comum: toda a pipeline (Pix, cartão,
 * retenção, fila de entrega, livro-razão) já sabe lidar com ela.
 *
 * Duas decisões que definem a segurança disto:
 *
 *  • **a chave de API é guardada como hash.** Um dump do banco não devolve
 *    acesso a nenhuma loja. A chave em claro existe uma única vez, na resposta
 *    da criação — se a loja perder, gera outra;
 *  • **o webhook que enviamos é assinado** com um segredo por loja, no mesmo
 *    esquema que os PSPs usam (`t=<unix>,v1=<hmac>`). Sem isso, qualquer um
 *    poderia postar "pagamento aprovado" no endpoint da loja.
 */

const log = logger.child({ scope: 'merchant' });

const KEY_PREFIX = 'sk_live_';

function hashKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

// ─────────────────────────── Cadastro ───────────────────────────

export interface CreatedMerchant {
  merchant: Merchant;
  /** Mostrada uma única vez. Não é recuperável depois. */
  apiKey: string;
  webhookSecret: string;
}

/**
 * Cria loja já habilitada, direto pelo operador.
 *
 * É o atalho para o caso em que a relação foi fechada fora do sistema (uma
 * loja que o operador conhece, um piloto combinado por telefone) e refazer o
 * caminho de cadastro + pedido + aprovação seria cerimônia sem ganho.
 *
 * O caminho normal — e o único aberto ao público — continua sendo a conta em
 * /loja: ver `signUp` e `approveApplication`. Aqui não há senha de portal: a
 * loja usa "esqueci a senha" para ganhar acesso ao painel, ou o operador emite
 * uma temporária.
 */
export async function createMerchant(input: {
  name: string;
  email: string;
  callbackUrl?: string | undefined;
}): Promise<CreatedMerchant> {
  const name = String(input.name ?? '').trim();
  const email = String(input.email ?? '').trim().toLowerCase();

  if (name.length < 2) {
    throw new GatewayError('nome da loja é obrigatório', 'INVALID_BODY', false);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    throw new GatewayError('e-mail inválido', 'INVALID_EMAIL', false);
  }
  if (input.callbackUrl) assertHttpsUrl(input.callbackUrl, 'callbackUrl');

  const apiKey = `${KEY_PREFIX}${crypto.randomBytes(24).toString('base64url')}`;
  const webhookSecret = `whsec_${crypto.randomBytes(24).toString('base64url')}`;

  const merchant = await prisma.merchant.create({
    data: {
      name,
      email,
      apiKeyHash: hashKey(apiKey),
      apiKeyPrefix: apiKey.slice(0, 16),
      apiKeyIssuedAt: new Date(),
      status: 'aprovado',
      webhookSecret,
      ...(input.callbackUrl !== undefined ? { callbackUrl: input.callbackUrl } : {}),
    },
  });

  log.warn({ merchantId: merchant.id, name }, 'loja criada com chave de API');
  return { merchant, apiKey, webhookSecret };
}

/**
 * Autentica pela chave de API.
 *
 * Comparação por hash e não por igualdade de string: além de não guardar a
 * chave, evita que o tempo de comparação vaze o prefixo correto.
 */
export async function authenticateMerchant(apiKey: string): Promise<Merchant | null> {
  if (!apiKey || !apiKey.startsWith(KEY_PREFIX)) return null;

  const merchant = await prisma.merchant.findUnique({ where: { apiKeyHash: hashKey(apiKey) } });
  if (!merchant || !merchant.active) return null;
  // Uma chave de loja suspensa ou ainda não aprovada não cobra: o estado da
  // relação comercial manda, não a existência da credencial.
  if (merchant.status !== 'aprovado') return null;

  // Só para o painel mostrar quais lojas estão de fato integrando.
  void prisma.merchant
    .update({ where: { id: merchant.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);

  return merchant;
}

export async function rotateApiKey(merchantId: string): Promise<string> {
  const apiKey = `${KEY_PREFIX}${crypto.randomBytes(24).toString('base64url')}`;
  await prisma.merchant.update({
    where: { id: merchantId },
    data: { apiKeyHash: hashKey(apiKey), apiKeyPrefix: apiKey.slice(0, 16) },
  });
  log.warn({ merchantId }, 'chave de API rotacionada — a anterior deixou de valer');
  return apiKey;
}

export async function setMerchantActive(merchantId: string, active: boolean): Promise<void> {
  await prisma.merchant.update({ where: { id: merchantId }, data: { active } });
  log.warn({ merchantId, active }, 'loja ativada/desativada');
}

export async function listMerchants(): Promise<
  Array<{
    id: string;
    name: string;
    email: string;
    apiKeyPrefix: string | null;
    status: string;
    active: boolean;
    callbackUrl: string | null;
    charges: number;
    createdAt: string;
    lastUsedAt: string | null;
  }>
> {
  const merchants = await prisma.merchant.findMany({ orderBy: { createdAt: 'desc' } });
  const counts = await prisma.depositIntent.groupBy({
    by: ['merchantId'],
    where: { merchantId: { not: null } },
    _count: { _all: true },
  });
  const byId = new Map(counts.map((c) => [c.merchantId, c._count._all]));

  return merchants.map((m) => ({
    id: m.id,
    name: m.name,
    email: m.email,
    apiKeyPrefix: m.apiKeyPrefix,
    status: m.status,
    active: m.active,
    callbackUrl: m.callbackUrl,
    charges: byId.get(m.id) ?? 0,
    createdAt: m.createdAt.toISOString(),
    lastUsedAt: m.lastUsedAt?.toISOString() ?? null,
  }));
}

// ─────────────────────────── Notificação ───────────────────────────

/**
 * Recusa URLs que não sejam HTTPS públicas.
 *
 * Um `callbackUrl` apontando para a rede interna transformaria o nosso
 * servidor em ferramenta de varredura da própria infraestrutura (SSRF): a loja
 * escreve `http://169.254.169.254/...` e nós buscamos por ela. HTTP simples
 * também sai: a notificação carrega valor e estado de pagamento.
 */
export function assertHttpsUrl(raw: string, campo: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GatewayError(`${campo} não é uma URL válida`, 'INVALID_URL', false);
  }

  if (url.protocol !== 'https:') {
    throw new GatewayError(`${campo} precisa ser https`, 'INVALID_URL', false);
  }

  const host = url.hostname.toLowerCase();
  const privado =
    host === 'localhost' ||
    host === '::1' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);

  if (privado) {
    throw new GatewayError(
      `${campo} aponta para um endereço interno — use um domínio público`,
      'INVALID_URL',
      false,
    );
  }
  return url;
}

export interface ChargeView {
  id: string;
  status: 'pendente' | 'pago' | 'entregue' | 'expirado' | 'cancelado' | 'falhou';
  amount: string;
  currency: string;
  externalId: string | null;
  checkoutUrl: string;
  destinationWallet: string;
  solDelivered: number | null;
  payoutSignature: string | null;
  createdAt: string;
  expiresAt: string;
}

/** Estado que a loja vê. Traduz o vocabulário interno para o dela. */
export function toChargeView(
  intent: DepositIntent,
  order: { status: string; customerLamports: bigint | null; customerPayoutSignature: string | null } | null,
): ChargeView {
  const base = config.mercadopago.publicBaseUrl.replace(/\/+$/, '');

  let status: ChargeView['status'] = 'pendente';
  if (intent.status === DepositIntentStatus.EXPIRED) status = 'expirado';
  else if (intent.status === DepositIntentStatus.CANCELLED) status = 'cancelado';
  else if (intent.status === DepositIntentStatus.CONFIRMED) {
    if (order?.status === OrderStatus.SETTLED || order?.status === OrderStatus.DISTRIBUTED) {
      status = 'entregue';
    } else if (order?.status === OrderStatus.FAILED) status = 'falhou';
    else status = 'pago';
  }

  return {
    id: intent.reference,
    status,
    amount: intent.fiatAmount.toString(),
    currency: intent.fiatCurrency,
    externalId: intent.merchantExternalId,
    checkoutUrl: `${base}/pay?ref=${intent.reference}`,
    destinationWallet: intent.customerWallet,
    solDelivered:
      order?.customerLamports == null ? null : Number(order.customerLamports) / LAMPORTS_PER_SOL,
    payoutSignature: order?.customerPayoutSignature ?? null,
    createdAt: intent.createdAt.toISOString(),
    expiresAt: intent.expiresAt.toISOString(),
  };
}

/** Assina no mesmo esquema dos PSPs: `t=<unix>,v1=<hmac do "t.corpo">`. */
export function signPayload(secret: string, body: string, timestamp: number): string {
  const hmac = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${hmac}`;
}

/**
 * Avisa a loja. Uma tentativa por chamada — a repetição é do varredor.
 *
 * Só notifica estados que interessam à loja: pago (libere o pedido) e entregue
 * (o cliente recebeu o SOL). Mandar cada transição interna seria ruído no
 * endpoint dela.
 */
export async function notifyMerchant(intentId: string): Promise<boolean> {
  const intent = await prisma.depositIntent.findUnique({
    where: { id: intentId },
    include: { merchant: true },
  });
  if (!intent?.merchant) return false;

  const url = intent.merchantCallbackUrl ?? intent.merchant.callbackUrl;
  if (!url) return false;

  const order =
    intent.orderId === null
      ? null
      : await prisma.order.findUnique({
          where: { id: intent.orderId },
          select: { status: true, customerLamports: true, customerPayoutSignature: true },
        });

  const view = toChargeView(intent, order);
  if (view.status !== 'pago' && view.status !== 'entregue' && view.status !== 'falhou') {
    return false;
  }

  const body = JSON.stringify({ event: `charge.${view.status}`, charge: view });
  const timestamp = Math.floor(Date.now() / 1000);

  try {
    await axios.post(url, body, {
      timeout: 10_000,
      headers: {
        'Content-Type': 'application/json',
        'X-Gateway-Signature': signPayload(intent.merchant.webhookSecret, body, timestamp),
      },
      // 2xx é sucesso; qualquer outra coisa vira retentativa.
      validateStatus: (status) => status >= 200 && status < 300,
    });

    await prisma.depositIntent.update({
      where: { id: intent.id },
      data: { notifiedAt: new Date(), notifyLastError: null },
    });
    log.info({ reference: intent.reference, status: view.status }, 'loja notificada');
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.depositIntent.update({
      where: { id: intent.id },
      data: {
        notifyAttempts: { increment: 1 },
        notifyLastError: message.slice(0, 300),
      },
    });
    log.warn({ reference: intent.reference, err: message }, 'falha ao notificar a loja');
    return false;
  }
}

/** Máximo de tentativas antes de desistir e deixar para a consulta da loja. */
const MAX_NOTIFY_ATTEMPTS = 8;

/**
 * Repete as notificações que não passaram.
 *
 * O endpoint da loja cai, faz deploy, dá timeout. Sem repetição, um pedido pago
 * ficaria sem liberação por um soluço de rede do outro lado — e a loja só
 * descobriria pelo cliente reclamando.
 */
export async function retryMerchantNotifications(): Promise<{ tried: number; sent: number }> {
  const pendentes = await prisma.depositIntent.findMany({
    where: {
      merchantId: { not: null },
      notifiedAt: null,
      status: DepositIntentStatus.CONFIRMED,
      notifyAttempts: { lt: MAX_NOTIFY_ATTEMPTS },
    },
    select: { id: true },
    take: 25,
  });

  let sent = 0;
  for (const { id } of pendentes) {
    if (await notifyMerchant(id)) sent += 1;
  }
  return { tried: pendentes.length, sent };
}
