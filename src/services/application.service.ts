import type { Merchant, MerchantApplication } from '@prisma/client';
import { prisma } from '../database/client';
import { GatewayError } from '../types';
import { logger } from '../utils/logger';
import { assertHttpsUrl } from './merchant.service';
import { MerchantStatus, NotificationKind, notify } from './merchant-account.service';

/**
 * Pedidos de lojas para integrar o gateway.
 *
 * O pedido agora sai de DENTRO de uma conta já criada, e não de um formulário
 * aberto na internet. A diferença não é burocrática:
 *
 *  • o spam cai por si — para pedir é preciso ter cadastrado uma conta antes;
 *  • existe para onde responder. O maior defeito do formulário anônimo era
 *    não ter destinatário: aprovado ou recusado, a resposta ficava presa no
 *    painel do operador esperando que alguém a copiasse para um e-mail.
 *
 * O que não mudou: um pedido não é uma loja habilitada. A chave de API só
 * passa a ser emissível depois da aprovação, que é um clique consciente do
 * operador.
 */

const log = logger.child({ scope: 'application' });

export const ApplicationStatus = {
  PENDENTE: 'pendente',
  APROVADO: 'aprovado',
  RECUSADO: 'recusado',
} as const;

/**
 * Pedidos que uma MESMA conta pode abrir por hora.
 *
 * Era um limite por IP, de quando o formulário era anônimo. Agora ele estaria
 * no lugar errado: cinco lojas atrás do mesmo NAT — um prédio comercial, um
 * coworking — e a sexta não conseguiria se candidatar por culpa das vizinhas.
 * O identificador passou a ser a conta, e o freio acompanha.
 *
 * O spam de verdade já morreu antes: para pedir é preciso ter cadastrado uma
 * conta, e uma conta só tem um pedido aberto de cada vez.
 */
const MAX_POR_LOJA_HORA = 5;

const VOLUMES = [
  'até R$ 5 mil/mês',
  'R$ 5 mil a R$ 50 mil/mês',
  'R$ 50 mil a R$ 500 mil/mês',
  'acima de R$ 500 mil/mês',
] as const;

/** Faturamento que a loja já tem hoje, fora do gateway. */
const FATURAMENTOS = [
  'ainda não faturo',
  'até R$ 10 mil/mês',
  'R$ 10 mil a R$ 100 mil/mês',
  'R$ 100 mil a R$ 1 milhão/mês',
  'acima de R$ 1 milhão/mês',
] as const;

const TICKETS = [
  'até R$ 50',
  'R$ 50 a R$ 200',
  'R$ 200 a R$ 1.000',
  'acima de R$ 1.000',
] as const;

const TEMPOS = [
  'ainda vou abrir',
  'menos de 1 ano',
  '1 a 3 anos',
  'mais de 3 anos',
] as const;

export const VOLUMES_ACEITOS: readonly string[] = VOLUMES;
export const FATURAMENTOS_ACEITOS: readonly string[] = FATURAMENTOS;
export const TICKETS_ACEITOS: readonly string[] = TICKETS;
export const TEMPOS_ACEITOS: readonly string[] = TEMPOS;

/** Aceita só o que veio da lista; qualquer outra coisa vira null. */
function daLista(valor: unknown, lista: readonly string[]): string | null {
  const v = String(valor ?? '');
  return lista.includes(v) ? v : null;
}

export interface ApplicationInput {
  /** A conta que está pedindo. É ela que recebe a resposta. */
  merchant: Merchant;
  companyName: string;
  legalName?: string | undefined;
  taxId?: string | undefined;
  phone?: string | undefined;
  website?: string | undefined;
  callbackUrl?: string | undefined;
  expectedVolume?: string | undefined;
  description?: string | undefined;
  // ── financeiro ──
  monthlyRevenue?: string | undefined;
  averageTicket?: string | undefined;
  timeOperating?: string | undefined;
  payoutSummary?: string | undefined;
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

async function assertRateLimit(merchantId: string): Promise<void> {
  const desde = new Date(Date.now() - 3_600_000);
  const recentes = await prisma.merchantApplication.count({
    where: { merchantId, createdAt: { gte: desde } },
  });
  if (recentes >= MAX_POR_LOJA_HORA) {
    throw new GatewayError(
      'você enviou pedidos demais na última hora — aguarde antes de tentar de novo',
      'RATE_LIMITED',
      false,
    );
  }
}

/**
 * Registra o pedido e coloca a conta em análise.
 *
 * Os dados da empresa também vão para a conta: são os mesmos campos, e mantê-los
 * em dois lugares que divergem é pior do que copiá-los uma vez. O pedido guarda
 * o retrato do que foi analisado; a conta guarda o valor corrente.
 */
export async function submitApplication(input: ApplicationInput): Promise<MerchantApplication> {
  const loja = input.merchant;

  if (loja.status === MerchantStatus.EM_ANALISE) {
    throw new GatewayError(
      'o seu pedido já está em análise — você recebe o retorno aqui mesmo',
      'DUPLICATE_APPLICATION',
      false,
    );
  }
  if (loja.status === MerchantStatus.APROVADO) {
    throw new GatewayError('a sua loja já está aprovada', 'ALREADY_APPROVED', false);
  }

  const companyName = texto(input.companyName, 'nome da empresa', { min: 2, obrigatorio: true });
  if (input.callbackUrl) assertHttpsUrl(input.callbackUrl, 'URL de webhook');
  if (input.website) assertHttpsUrl(input.website, 'site');

  await assertRateLimit(loja.id);

  const dados = {
    companyName,
    email: loja.email,
    legalName: texto(input.legalName, 'razão social') || null,
    taxId: texto(input.taxId, 'CNPJ') || null,
    phone: texto(input.phone, 'telefone') || null,
    website: input.website ?? null,
    callbackUrl: input.callbackUrl ?? null,
    expectedVolume: daLista(input.expectedVolume, VOLUMES),
    description: texto(input.description, 'descrição', { max: 2000 }) || null,
    monthlyRevenue: daLista(input.monthlyRevenue, FATURAMENTOS),
    averageTicket: daLista(input.averageTicket, TICKETS),
    timeOperating: daLista(input.timeOperating, TEMPOS),
    payoutSummary: input.payoutSummary?.trim().slice(0, 300) || null,
  };

  const [pedido] = await prisma.$transaction([
    prisma.merchantApplication.create({
      data: {
        ...dados,
        merchantId: loja.id,
        status: ApplicationStatus.PENDENTE,
        ...(input.clientIp !== undefined ? { clientIp: input.clientIp } : {}),
      },
    }),
    prisma.merchant.update({
      where: { id: loja.id },
      data: {
        name: companyName,
        legalName: dados.legalName,
        taxId: dados.taxId,
        phone: dados.phone,
        website: dados.website,
        callbackUrl: dados.callbackUrl,
        status: MerchantStatus.EM_ANALISE,
      },
    }),
  ]);

  await notify(
    loja.id,
    NotificationKind.AVISO,
    'Pedido enviado para análise',
    'Assim que tivermos uma resposta, ela aparece aqui no seu painel.',
    'inicio',
  );

  log.warn(
    { id: pedido.id, empresa: companyName, merchantId: loja.id },
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
    monthlyRevenue: string | null;
    averageTicket: string | null;
    timeOperating: string | null;
    payoutSummary: string | null;
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
    monthlyRevenue: p.monthlyRevenue,
    averageTicket: p.averageTicket,
    timeOperating: p.timeOperating,
    payoutSummary: p.payoutSummary,
    status: p.status,
    reviewNote: p.reviewNote,
    merchantId: p.merchantId,
    createdAt: p.createdAt.toISOString(),
    reviewedAt: p.reviewedAt?.toISOString() ?? null,
  }));
}

export interface ApprovalResult {
  merchantId: string;
  companyName: string;
  portalEmail: string;
}

/**
 * Aprova o pedido: a conta passa a poder emitir chave e cobrar.
 *
 * Repare no que este passo NÃO faz mais: não cria loja (ela já existe desde o
 * cadastro), não gera senha (o dono escolheu a dele) e não devolve a chave de
 * API. A chave é emitida pela própria loja, no painel dela, quando quiser — é
 * o único desenho em que a credencial nunca precisa passar pelas mãos do
 * operador nem por uma mensagem de WhatsApp para chegar a quem é dela.
 *
 * O que ele faz é o que faltava: avisa. A loja abre o painel e encontra a
 * resposta lá.
 */
export async function approveApplication(id: string, note?: string): Promise<ApprovalResult> {
  const pedido = await prisma.merchantApplication.findUnique({ where: { id } });
  if (!pedido) throw new GatewayError('pedido não encontrado', 'NOT_FOUND', false);

  if (pedido.status === ApplicationStatus.APROVADO) {
    throw new GatewayError('este pedido já foi aprovado', 'ALREADY_APPROVED', false);
  }
  if (!pedido.merchantId) {
    throw new GatewayError(
      'este pedido é anterior ao cadastro de contas e não tem loja associada — ' +
        'peça que ela crie a conta em /loja e envie o pedido de novo',
      'LEGACY_APPLICATION',
      false,
    );
  }

  const loja = await prisma.merchant.findUnique({ where: { id: pedido.merchantId } });
  if (!loja) throw new GatewayError('a conta deste pedido não existe mais', 'NOT_FOUND', false);

  await prisma.$transaction([
    prisma.merchantApplication.update({
      where: { id },
      data: {
        status: ApplicationStatus.APROVADO,
        reviewNote: note?.trim() || null,
        reviewedAt: new Date(),
      },
    }),
    prisma.merchant.update({
      where: { id: loja.id },
      data: { status: MerchantStatus.APROVADO, active: true },
    }),
  ]);

  await notify(
    loja.id,
    NotificationKind.APROVADO,
    'Pedido aprovado — sua loja está habilitada',
    (note?.trim() ? note.trim() + ' ' : '') +
      'Emita a sua chave de API na aba Integração para começar a cobrar.',
    'integracao',
  );

  log.warn({ id, empresa: pedido.companyName, merchantId: loja.id }, 'pedido aprovado');

  return { merchantId: loja.id, companyName: loja.name, portalEmail: loja.email };
}

/**
 * Recusa. A conta continua existindo e o dono continua entrando.
 *
 * Ele precisa poder ler o motivo e corrigir — apagar a conta junto com a
 * recusa transformaria "faltou o CNPJ" em "comece tudo de novo do zero".
 */
export async function rejectApplication(id: string, note?: string): Promise<void> {
  const pedido = await prisma.merchantApplication.findUnique({ where: { id } });
  if (!pedido) throw new GatewayError('pedido não encontrado', 'NOT_FOUND', false);

  if (pedido.status === ApplicationStatus.APROVADO) {
    throw new GatewayError(
      'este pedido já foi aprovado e a loja está habilitada — suspenda a loja em Lojas ' +
        'em vez de recusar o pedido',
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

  if (pedido.merchantId) {
    await prisma.merchant.update({
      where: { id: pedido.merchantId },
      data: { status: MerchantStatus.RECUSADO },
    });
    await notify(
      pedido.merchantId,
      NotificationKind.RECUSADO,
      'Pedido não aprovado',
      note?.trim() ||
        'Confira os dados da empresa e envie um novo pedido. Se tiver dúvida, fale com o suporte.',
      'pedido',
    );
  }

  log.warn({ id, empresa: pedido.companyName }, 'pedido recusado');
}

/** Quantos pedidos aguardam análise — para o contador do painel. */
export async function countPending(): Promise<number> {
  return prisma.merchantApplication.count({ where: { status: ApplicationStatus.PENDENTE } });
}
