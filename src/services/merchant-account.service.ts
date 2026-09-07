import crypto from 'node:crypto';
import type { Merchant } from '@prisma/client';
import { prisma } from '../database/client';
import { GatewayError } from '../types';
import { logger } from '../utils/logger';
import { assertHttpsUrl } from './merchant.service';
import { hashMerchantPassword, verifyMerchantPassword } from './merchant-ledger.service';
import { NotificationKind, notify } from './merchant-notify.service';

/**
 * A conta da loja — cadastro, sessão, senha, credenciais e avisos.
 *
 * A mudança de fundo em relação ao desenho anterior: **a conta vem antes da
 * credencial**. Antes, uma loja só passava a existir quando o operador
 * aprovava, e a senha nascia junto com a chave de API. Isso deixava um buraco
 * no meio do caminho — entre pedir e ser aprovado, o dono da loja não tinha
 * onde entrar, e por isso não havia onde avisá-lo de nada.
 *
 * Agora ele cria a conta, pede a análise de dentro dela, e é lá que a resposta
 * chega. A aprovação deixa de ser um e-mail que alguém precisa lembrar de
 * mandar e passa a ser um estado que ele vê ao entrar.
 *
 * Três coisas que este arquivo se recusa a fazer:
 *
 *  • **guardar a chave de API em claro.** Ela aparece uma vez, na emissão, e
 *    depois só existe como hash. Quem perde, rotaciona;
 *  • **dizer se um e-mail existe.** Senha errada e conta inexistente dão a
 *    mesma resposta — a diferença seria um mapa de quem são os clientes;
 *  • **prometer e-mail que não temos.** Não há provedor de envio no sistema,
 *    então nada aqui finge mandar mensagem: a recuperação de senha vira fila
 *    para o operador, e o aviso de aprovação vira linha no painel da loja.
 */

const log = logger.child({ scope: 'merchant.account' });

const KEY_PREFIX = 'sk_live_';
const SESSION_DAYS = 14;

/** Estados da relação comercial. Ver o comentário de `status` no schema. */
export const MerchantStatus = {
  SEM_PEDIDO: 'sem_pedido',
  EM_ANALISE: 'em_analise',
  APROVADO: 'aprovado',
  RECUSADO: 'recusado',
} as const;

// ─────────────────────────── Primitivas ───────────────────────────

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function hashKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function normalizarEmail(valor: unknown): string {
  const email = String(valor ?? '').trim().toLowerCase();
  if (!RE_EMAIL.test(email)) throw new GatewayError('e-mail inválido', 'INVALID_EMAIL', false);
  return email.slice(0, 254);
}

/**
 * Regra de senha.
 *
 * Comprimento acima de tudo: uma frase longa resiste mais do que oito
 * caracteres com símbolo, e é o que as pessoas de fato conseguem lembrar.
 * Exigimos variedade só o bastante para barrar o teclado em sequência.
 */
export function assertSenhaForte(senha: string): void {
  if (senha.length < 10) {
    throw new GatewayError('a senha precisa de pelo menos 10 caracteres', 'WEAK_PASSWORD', false);
  }
  if (senha.length > 200) {
    throw new GatewayError('senha longa demais', 'WEAK_PASSWORD', false);
  }
  if (!/[a-zA-Z]/.test(senha) || !/[^a-zA-Z]/.test(senha)) {
    throw new GatewayError(
      'misture letras com números ou símbolos na senha',
      'WEAK_PASSWORD',
      false,
    );
  }
  const obvias = ['1234567890', 'senha123456', 'password123', 'qwertyuiop'];
  if (obvias.some((o) => senha.toLowerCase().includes(o))) {
    throw new GatewayError('essa senha é fácil demais de adivinhar', 'WEAK_PASSWORD', false);
  }
}

// ─────────────────────────── Cadastro ───────────────────────────

export interface SignUpInput {
  email: string;
  companyName: string;
  password: string;
  clientIp?: string | undefined;
}

/**
 * Cria a conta. Não cria chave, não libera cobrança.
 *
 * O que ela ganha aqui é o direito de entrar e pedir análise — nada além.
 * Emitir credencial num formulário aberto na internet seria dar poder de
 * cobrar a quem digitou um e-mail.
 */
export async function signUp(input: SignUpInput): Promise<Merchant> {
  const email = normalizarEmail(input.email);
  const name = String(input.companyName ?? '').trim().slice(0, 120);
  const senha = String(input.password ?? '');

  if (name.length < 2) {
    throw new GatewayError('informe o nome da sua loja', 'INVALID_BODY', false);
  }
  assertSenhaForte(senha);

  const existente = await prisma.merchant.findUnique({ where: { email } });
  if (existente) {
    // Aqui o e-mail já é conhecido de qualquer forma: quem tenta cadastrar
    // precisa saber que a conta existe para conseguir entrar nela.
    throw new GatewayError(
      'já existe uma conta com este e-mail — entre com ela ou recupere a senha',
      'EMAIL_IN_USE',
      false,
    );
  }

  const loja = await prisma.merchant.create({
    data: {
      name,
      email,
      status: MerchantStatus.SEM_PEDIDO,
      passwordHash: await hashMerchantPassword(senha),
      passwordChangedAt: new Date(),
      // Nasce agora: é com ele que a loja confere os webhooks que mandamos, e
      // isso não depende de aprovação nenhuma.
      webhookSecret: 'whsec_' + crypto.randomBytes(24).toString('base64url'),
      ...(input.clientIp !== undefined ? { clientIp: input.clientIp } : {}),
    },
  });

  await notify(
    loja.id,
    NotificationKind.AVISO,
    'Conta criada',
    'Para começar a cobrar, envie o pedido de análise com os dados da sua empresa.',
    'pedido',
  );

  log.warn({ merchantId: loja.id, email }, 'nova conta de loja');
  return loja;
}

// ─────────────────────────── Sessão ───────────────────────────

/** Tentativas erradas antes do bloqueio, e por quanto tempo ele dura. */
const MAX_TENTATIVAS = 8;
const BLOQUEIO_MS = 15 * 60_000;

export interface LoginResult {
  token: string;
  merchant: Merchant;
}

/**
 * Entra no portal.
 *
 * Conta inexistente, senha errada e conta suspensa dão a MESMA mensagem: a
 * diferença entre elas é exatamente o que um atacante usa para descobrir quais
 * e-mails são clientes. O bloqueio temporário transforma um ataque de
 * dicionário em algo inviável sem trancar o dono legítimo para sempre.
 */
export async function login(
  emailBruto: string,
  senha: string,
  clientIp?: string,
): Promise<LoginResult> {
  const invalido = new GatewayError('e-mail ou senha incorretos', 'INVALID_CREDENTIALS', false);
  const email = String(emailBruto ?? '').trim().toLowerCase();
  const loja = await prisma.merchant.findUnique({ where: { email } });

  if (!loja || !loja.passwordHash || !loja.active) throw invalido;

  if (loja.lockedUntil && loja.lockedUntil.getTime() > Date.now()) {
    const minutos = Math.ceil((loja.lockedUntil.getTime() - Date.now()) / 60_000);
    throw new GatewayError(
      'muitas tentativas — tente de novo em ' + minutos + ' minuto(s)',
      'LOCKED',
      false,
    );
  }

  if (!(await verifyMerchantPassword(senha, loja.passwordHash))) {
    const falhas = loja.failedLogins + 1;
    await prisma.merchant.update({
      where: { id: loja.id },
      data: {
        failedLogins: falhas,
        lockedUntil: falhas >= MAX_TENTATIVAS ? new Date(Date.now() + BLOQUEIO_MS) : null,
      },
    });
    if (falhas >= MAX_TENTATIVAS) {
      log.warn({ merchantId: loja.id, falhas }, 'conta de loja bloqueada por tentativas');
    }
    throw invalido;
  }

  const token = crypto.randomBytes(32).toString('base64url');
  const [, atualizada] = await prisma.$transaction([
    prisma.merchantSession.create({
      data: {
        tokenHash: hashToken(token),
        merchantId: loja.id,
        expiresAt: new Date(Date.now() + SESSION_DAYS * 24 * 3_600_000),
        ...(clientIp !== undefined ? { clientIp } : {}),
      },
    }),
    prisma.merchant.update({
      where: { id: loja.id },
      data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() },
    }),
  ]);

  log.info({ merchantId: loja.id }, 'loja entrou no portal');
  return { token, merchant: atualizada };
}

export async function resolveSession(token: string): Promise<Merchant | null> {
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

export async function logout(token: string): Promise<void> {
  if (!token) return;
  await prisma.merchantSession
    .delete({ where: { tokenHash: hashToken(token) } })
    .catch(() => undefined);
}

export interface SessionView {
  id: string;
  clientIp: string | null;
  createdAt: string;
  expiresAt: string;
  current: boolean;
}

export async function listSessions(merchantId: string, tokenAtual: string): Promise<SessionView[]> {
  const hashAtual = tokenAtual ? hashToken(tokenAtual) : '';
  const sessoes = await prisma.merchantSession.findMany({
    where: { merchantId, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  return sessoes.map((s) => ({
    id: s.id,
    clientIp: s.clientIp,
    createdAt: s.createdAt.toISOString(),
    expiresAt: s.expiresAt.toISOString(),
    current: s.tokenHash === hashAtual,
  }));
}

/**
 * Encerra todas as outras sessões.
 *
 * É o botão que importa quando alguém perde o telefone: sem ele, trocar a
 * senha não expulsaria quem já estava dentro.
 */
export async function revokeOtherSessions(merchantId: string, tokenAtual: string): Promise<number> {
  const { count } = await prisma.merchantSession.deleteMany({
    where: {
      merchantId,
      ...(tokenAtual ? { tokenHash: { not: hashToken(tokenAtual) } } : {}),
    },
  });
  log.warn({ merchantId, count }, 'sessões da loja revogadas');
  return count;
}

// ─────────────────────────── Senha ───────────────────────────

export async function changePassword(
  merchant: Merchant,
  atual: string,
  nova: string,
  tokenAtual: string,
): Promise<void> {
  if (!merchant.passwordHash) {
    throw new GatewayError('esta conta ainda não tem senha', 'NO_PASSWORD', false);
  }
  if (!(await verifyMerchantPassword(atual, merchant.passwordHash))) {
    throw new GatewayError('a senha atual está incorreta', 'INVALID_CREDENTIALS', false);
  }
  if (atual === nova) {
    throw new GatewayError('a nova senha precisa ser diferente da atual', 'WEAK_PASSWORD', false);
  }
  assertSenhaForte(nova);

  await prisma.merchant.update({
    where: { id: merchant.id },
    data: {
      passwordHash: await hashMerchantPassword(nova),
      passwordChangedAt: new Date(),
      mustChangePassword: false,
      failedLogins: 0,
      lockedUntil: null,
    },
  });

  // Trocar a senha e deixar as outras sessões abertas seria trocar a fechadura
  // com as cópias antigas ainda funcionando.
  await revokeOtherSessions(merchant.id, tokenAtual);

  await notify(
    merchant.id,
    NotificationKind.SENHA,
    'Senha alterada',
    'As outras sessões foram encerradas. Se não foi você, fale com o suporte agora.',
    'config',
  );
  log.warn({ merchantId: merchant.id }, 'senha da loja alterada');
}

/**
 * Pede recuperação de senha.
 *
 * Devolve sempre a mesma resposta, exista a conta ou não — a resposta é o
 * lugar mais fácil de vazar quem é cliente. Quem existe entra na fila do
 * operador; quem não existe não deixa rastro nenhum.
 */
export async function requestPasswordReset(emailBruto: string, clientIp?: string): Promise<void> {
  const email = String(emailBruto ?? '').trim().toLowerCase();
  const loja = await prisma.merchant.findUnique({ where: { email } });
  if (!loja) return;

  const jaPedido = await prisma.merchantPasswordReset.findFirst({
    where: { merchantId: loja.id, status: 'pendente' },
  });
  if (jaPedido) return;

  await prisma.merchantPasswordReset.create({
    data: { merchantId: loja.id, ...(clientIp !== undefined ? { clientIp } : {}) },
  });
  log.warn({ merchantId: loja.id }, 'loja pediu recuperação de senha — fila do operador');
}

/** O operador atende: emite senha temporária que a loja é obrigada a trocar. */
export async function resolvePasswordReset(
  id: string,
  note?: string,
): Promise<{ email: string; tempPassword: string }> {
  const pedido = await prisma.merchantPasswordReset.findUnique({
    where: { id },
    include: { merchant: true },
  });
  if (!pedido) throw new GatewayError('pedido não encontrado', 'NOT_FOUND', false);
  if (pedido.status !== 'pendente') {
    throw new GatewayError('este pedido já foi resolvido', 'ALREADY_DONE', false);
  }

  const temporaria = crypto.randomBytes(9).toString('base64url');
  await prisma.$transaction([
    prisma.merchant.update({
      where: { id: pedido.merchantId },
      data: {
        passwordHash: await hashMerchantPassword(temporaria),
        passwordChangedAt: new Date(),
        mustChangePassword: true,
        failedLogins: 0,
        lockedUntil: null,
      },
    }),
    // A senha antiga deixou de valer; as sessões abertas com ela também.
    prisma.merchantSession.deleteMany({ where: { merchantId: pedido.merchantId } }),
    prisma.merchantPasswordReset.update({
      where: { id },
      data: { status: 'atendido', resolvedAt: new Date(), note: note?.trim() || null },
    }),
  ]);

  await notify(
    pedido.merchantId,
    NotificationKind.SENHA,
    'Senha temporária emitida',
    'Troque-a assim que entrar. Enquanto não trocar, o resto do painel fica bloqueado.',
    'config',
  );

  log.warn({ merchantId: pedido.merchantId }, 'senha temporária emitida pelo operador');
  return { email: pedido.merchant.email, tempPassword: temporaria };
}

export async function cancelPasswordReset(id: string, note?: string): Promise<void> {
  await prisma.merchantPasswordReset.update({
    where: { id },
    data: { status: 'cancelado', resolvedAt: new Date(), note: note?.trim() || null },
  });
}

export async function listPasswordResets(): Promise<
  Array<{
    id: string;
    merchantId: string;
    merchantName: string;
    email: string;
    status: string;
    clientIp: string | null;
    createdAt: string;
    resolvedAt: string | null;
  }>
> {
  const pedidos = await prisma.merchantPasswordReset.findMany({
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    take: 100,
    include: { merchant: { select: { name: true, email: true } } },
  });

  return pedidos.map((p) => ({
    id: p.id,
    merchantId: p.merchantId,
    merchantName: p.merchant.name,
    email: p.merchant.email,
    status: p.status,
    clientIp: p.clientIp,
    createdAt: p.createdAt.toISOString(),
    resolvedAt: p.resolvedAt?.toISOString() ?? null,
  }));
}

export async function countPendingResets(): Promise<number> {
  return prisma.merchantPasswordReset.count({ where: { status: 'pendente' } });
}

// ─────────────────────────── Credenciais ───────────────────────────

/**
 * Emite (ou troca) a chave de API da loja.
 *
 * Só depois de aprovada: a chave é a permissão de cobrar dinheiro de terceiros,
 * e ela nasce do julgamento do operador, não do cadastro.
 *
 * Devolvida em claro uma única vez. O banco fica com o hash — se a loja perder,
 * a resposta certa é emitir outra, não recuperar a antiga.
 */
export async function issueApiKey(
  merchantId: string,
): Promise<{ apiKey: string; prefix: string; rotated: boolean }> {
  const loja = await prisma.merchant.findUnique({ where: { id: merchantId } });
  if (!loja) throw new GatewayError('loja não encontrada', 'NOT_FOUND', false);

  if (loja.status !== MerchantStatus.APROVADO || !loja.active) {
    throw new GatewayError(
      'a chave de API só é emitida depois que o seu pedido for aprovado',
      'NOT_APPROVED',
      false,
    );
  }

  const rotated = loja.apiKeyHash !== null;
  const apiKey = KEY_PREFIX + crypto.randomBytes(24).toString('base64url');
  const prefix = apiKey.slice(0, 16);

  await prisma.merchant.update({
    where: { id: merchantId },
    data: { apiKeyHash: hashKey(apiKey), apiKeyPrefix: prefix, apiKeyIssuedAt: new Date() },
  });

  await notify(
    merchantId,
    NotificationKind.CHAVE,
    rotated ? 'Chave de API trocada' : 'Chave de API emitida',
    rotated
      ? 'A chave anterior deixou de funcionar. Atualize o servidor da sua loja.'
      : 'Guarde-a em lugar seguro: ela não aparece de novo.',
    'integracao',
  );

  log.warn({ merchantId, rotated }, 'chave de API emitida');
  return { apiKey, prefix, rotated };
}

export async function rotateWebhookSecret(merchantId: string): Promise<string> {
  const secret = 'whsec_' + crypto.randomBytes(24).toString('base64url');
  await prisma.merchant.update({ where: { id: merchantId }, data: { webhookSecret: secret } });
  await notify(
    merchantId,
    NotificationKind.CHAVE,
    'Segredo de webhook trocado',
    'As notificações passam a ser assinadas com o novo segredo.',
    'integracao',
  );
  log.warn({ merchantId }, 'segredo de webhook rotacionado');
  return secret;
}

// ─────────────────────────── Perfil ───────────────────────────

export interface ProfileInput {
  companyName?: string | undefined;
  legalName?: string | undefined;
  taxId?: string | undefined;
  phone?: string | undefined;
  website?: string | undefined;
  callbackUrl?: string | undefined;
  returnUrl?: string | undefined;
}

function opcional(valor: string | undefined, max: number): string | null | undefined {
  if (valor === undefined) return undefined;
  const v = valor.trim();
  return v === '' ? null : v.slice(0, max);
}

export async function updateProfile(merchantId: string, input: ProfileInput): Promise<Merchant> {
  const dados: Record<string, string | null> = {};

  if (input.companyName !== undefined) {
    const nome = input.companyName.trim();
    if (nome.length < 2) throw new GatewayError('nome da loja é obrigatório', 'INVALID_BODY', false);
    dados.name = nome.slice(0, 120);
  }

  const legalName = opcional(input.legalName, 160);
  if (legalName !== undefined) dados.legalName = legalName;
  const taxId = opcional(input.taxId, 40);
  if (taxId !== undefined) dados.taxId = taxId;
  const phone = opcional(input.phone, 40);
  if (phone !== undefined) dados.phone = phone;

  // URLs passam pela mesma checagem do resto do sistema: https pública, nunca
  // endereço interno. Um callback apontando para a rede da nossa infra nos
  // transformaria em ferramenta de varredura dela.
  const website = opcional(input.website, 300);
  if (website !== undefined) {
    if (website !== null) assertHttpsUrl(website, 'site');
    dados.website = website;
  }
  const callbackUrl = opcional(input.callbackUrl, 300);
  if (callbackUrl !== undefined) {
    if (callbackUrl !== null) assertHttpsUrl(callbackUrl, 'URL de webhook');
    dados.callbackUrl = callbackUrl;
  }
  const returnUrl = opcional(input.returnUrl, 300);
  if (returnUrl !== undefined) {
    if (returnUrl !== null) assertHttpsUrl(returnUrl, 'URL de retorno');
    dados.returnUrl = returnUrl;
  }

  return prisma.merchant.update({ where: { id: merchantId }, data: dados });
}

export { NotificationKind, notify } from './merchant-notify.service';
export { listNotifications, markNotificationsRead } from './merchant-notify.service';
export type { NotificationView } from './merchant-notify.service';
