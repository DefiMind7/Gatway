import type { MerchantApplication } from '@prisma/client';
import { prisma } from '../database/client';
import { GatewayError } from '../types';
import { logger } from '../utils/logger';
import { assertHttpsUrl, createMerchant } from './merchant.service';

/**
 * Pedidos de lojas para integrar o gateway.
 *
 * O formulário é público — é a porta de entrada comercial. Isso traz dois
 * problemas que o código resolve aqui:
 *
 *  • **spam**: qualquer robô que ache a página pode encher a tabela. Há limite
 *    por IP e por e-mail, e o mesmo e-mail não abre dois pedidos em aberto;
 *  • **confusão entre pedido e credencial**: um pedido não é uma loja. A chave
 *    de API só nasce na aprovação, que é um clique consciente do operador.
 */

const log = logger.child({ scope: 'application' });

export const ApplicationStatus = {
  PENDENTE: 'pendente',
  APROVADO: 'aprovado',
  RECUSADO: 'recusado',
} as const;

/** Pedidos por IP por hora. Freio de spam no endpoint público. */
const MAX_POR_IP_HORA = 5;

const VOLUMES = [
  'até R$ 5 mil/mês',
  'R$ 5 mil a R$ 50 mil/mês',
  'R$ 50 mil a R$ 500 mil/mês',
  'acima de R$ 500 mil/mês',
] as const;

export const VOLUMES_ACEITOS: readonly string[] = VOLUMES;

export interface ApplicationInput {
  companyName: string;
  email: string;
  legalName?: string | undefined;
  taxId?: string | undefined;
  phone?: string | undefined;
  website?: string | undefined;
  callbackUrl?: string | undefined;
  expectedVolume?: string | undefined;
  description?: string | undefined;
  clientIp?: string | undefined;
}

function texto(valor: unknown, campo: string, { min = 0, max = 500, obrigatorio = false } = {}): string {
  const v = String(valor ?? '').trim();
  if (v === '') {
    if (obrigatorio) throw new GatewayError(`${campo} é obrigatório`, 'INVALID_BODY', false);
    return '';
  }
  if (v.length < min) {
    throw new GatewayError(`${campo} precisa de ao menos ${min} caracteres`, 'INVALID_BODY', false);
  }
  return v.slice(0, max);
}

async function assertRateLimit(ip: string | undefined): Promise<void> {
  if (!ip) return;
  const desde = new Date(Date.now() - 3_600_000);
  const recentes = await prisma.merchantApplication.count({
    where: { clientIp: ip, createdAt: { gte: desde } },
  });
  if (recentes >= MAX_POR_IP_HORA) {
    throw new GatewayError(
      'muitos pedidos deste endereço na última hora — tente mais tarde',
      'RATE_LIMITED',
      false,
    );
  }
}

/** Registra o pedido. Não cria loja nem chave — isso é da aprovação. */
export async function submitApplication(input: ApplicationInput): Promise<MerchantApplication> {
  const companyName = texto(input.companyName, 'nome da empresa', { min: 2, obrigatorio: true });
  const email = texto(input.email, 'e-mail', { obrigatorio: true }).toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    throw new GatewayError('e-mail inválido', 'INVALID_EMAIL', false);
  }
  if (input.callbackUrl) assertHttpsUrl(input.callbackUrl, 'URL de webhook');
  if (input.website) assertHttpsUrl(input.website, 'site');

  await assertRateLimit(input.clientIp);

  // Um e-mail com pedido em análise não abre outro: duplicata vira fila dupla
  // no painel e a loja acha que o primeiro se perdeu.
  const emAberto = await prisma.merchantApplication.findFirst({
    where: { email, status: ApplicationStatus.PENDENTE },
  });
  if (emAberto) {
    throw new GatewayError(
      'já existe um pedido em análise para este e-mail — aguarde o retorno',
      'DUPLICATE_APPLICATION',
      false,
    );
  }

  const pedido = await prisma.merchantApplication.create({
    data: {
      companyName,
      email,
      legalName: texto(input.legalName, 'razão social') || null,
      taxId: texto(input.taxId, 'CNPJ') || null,
      phone: texto(input.phone, 'telefone') || null,
      website: input.website ?? null,
      callbackUrl: input.callbackUrl ?? null,
      expectedVolume: VOLUMES_ACEITOS.includes(String(input.expectedVolume))
        ? String(input.expectedVolume)
        : null,
      description: texto(input.description, 'descrição', { max: 2000 }) || null,
      status: ApplicationStatus.PENDENTE,
      ...(input.clientIp !== undefined ? { clientIp: input.clientIp } : {}),
    },
  });

  log.warn(
    { id: pedido.id, empresa: companyName, email },
    'novo pedido de integração — aguardando análise',
  );
  return pedido;
}

export async function listApplications(status?: string): Promise<
  Array<{
    id: string;
    companyName: string;
    legalName: string | null;
    taxId: string | null;
    email: string;
    phone: string | null;
    website: string | null;
    callbackUrl: string | null;
    expectedVolume: string | null;
    description: string | null;
    status: string;
    reviewNote: string | null;
    merchantId: string | null;
    createdAt: string;
    reviewedAt: string | null;
  }>
> {
  const pedidos = await prisma.merchantApplication.findMany({
    ...(status ? { where: { status } } : {}),
    // Pendentes primeiro: é a fila que exige ação.
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    take: 100,
  });

  return pedidos.map((p) => ({
    id: p.id,
    companyName: p.companyName,
    legalName: p.legalName,
    taxId: p.taxId,
    email: p.email,
    phone: p.phone,
    website: p.website,
    callbackUrl: p.callbackUrl,
    expectedVolume: p.expectedVolume,
    description: p.description,
    status: p.status,
    reviewNote: p.reviewNote,
    merchantId: p.merchantId,
    createdAt: p.createdAt.toISOString(),
    reviewedAt: p.reviewedAt?.toISOString() ?? null,
  }));
}

export interface ApprovalResult {
  merchantId: string;
  /** Mostrada uma única vez. Mande para a loja por um canal seguro. */
  apiKey: string;
  webhookSecret: string;
}

/**
 * Aprova o pedido: cria a loja e devolve as credenciais.
 *
 * É aqui que uma intenção vira capacidade de cobrar. A chave aparece uma vez
 * só — o banco guarda apenas o hash — então o operador precisa copiá-la agora.
 */
export async function approveApplication(id: string, note?: string): Promise<ApprovalResult> {
  const pedido = await prisma.merchantApplication.findUnique({ where: { id } });
  if (!pedido) throw new GatewayError('pedido não encontrado', 'NOT_FOUND', false);

  if (pedido.status === ApplicationStatus.APROVADO) {
    throw new GatewayError(
      'este pedido já foi aprovado — a chave dele existe e não é recuperável. ' +
        'Se a loja perdeu, gere outra em Lojas.',
      'ALREADY_APPROVED',
      false,
    );
  }

  const criada = await createMerchant({
    name: pedido.companyName,
    email: pedido.email,
    callbackUrl: pedido.callbackUrl ?? undefined,
  });

  await prisma.merchantApplication.update({
    where: { id },
    data: {
      status: ApplicationStatus.APROVADO,
      merchantId: criada.merchant.id,
      reviewNote: note?.trim() || null,
      reviewedAt: new Date(),
    },
  });

  log.warn(
    { id, empresa: pedido.companyName, merchantId: criada.merchant.id },
    'pedido aprovado — loja criada',
  );

  return {
    merchantId: criada.merchant.id,
    apiKey: criada.apiKey,
    webhookSecret: criada.webhookSecret,
  };
}

export async function rejectApplication(id: string, note?: string): Promise<void> {
  const pedido = await prisma.merchantApplication.findUnique({ where: { id } });
  if (!pedido) throw new GatewayError('pedido não encontrado', 'NOT_FOUND', false);

  if (pedido.status === ApplicationStatus.APROVADO) {
    throw new GatewayError(
      'este pedido já foi aprovado e a loja existe — desative a loja em vez de recusar o pedido',
      'ALREADY_APPROVED',
      false,
    );
  }

  await prisma.merchantApplication.update({
    where: { id },
    data: {
      status: ApplicationStatus.RECUSADO,
      reviewNote: note?.trim() || null,
      reviewedAt: new Date(),
    },
  });

  log.warn({ id, empresa: pedido.companyName }, 'pedido recusado');
}

/** Quantos pedidos aguardam análise — para o contador do painel. */
export async function countPending(): Promise<number> {
  return prisma.merchantApplication.count({ where: { status: ApplicationStatus.PENDENTE } });
}
