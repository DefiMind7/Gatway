import crypto from 'node:crypto';
import axios, { AxiosError } from 'axios';
import type { Request } from 'express';
import { config } from '../config';
import { GatewayError, type SignatureVerification } from '../types';
import { logger } from '../utils/logger';

/**
 * Adapter do Mercado Pago — o trilho de CARTÃO.
 *
 * Fluxo: criamos uma *preferência* (Checkout Pro), mandamos o cliente para o
 * link dela, e o pagamento volta para nós por dois caminhos independentes:
 *
 *  1. **webhook** `POST /pay/mercadopago/webhook` — rápido, mas exige URL
 *     pública. Em `localhost` ele simplesmente não chega.
 *  2. **consulta ativa** por `external_reference` — o poll da própria página do
 *     cliente pergunta ao MP se aquela referência já foi paga.
 *
 * O segundo caminho não é redundância defensiva: é o que faz o trilho
 * funcionar em desenvolvimento sem túnel, e o que salva um webhook perdido em
 * produção. O MP entrega o webhook uma vez e desiste depois de algumas
 * tentativas; sem consulta ativa, um pagamento aprovado com o servidor fora do
 * ar ficaria invisível para sempre.
 *
 * Em qualquer caminho, o valor do dinheiro vem da resposta da API do MP, nunca
 * do que o cliente manda — o webhook só carrega um id.
 */

const log = logger.child({ scope: 'mercadopago' });

/** Estados do MP que consideramos dinheiro recebido. */
const APPROVED = new Set(['approved']);
/** Estados terminais sem dinheiro: não adianta continuar consultando. */
const DEAD = new Set(['rejected', 'cancelled', 'refunded', 'charged_back']);

export interface MpPayment {
  id: string;
  status: string;
  statusDetail: string | null;
  externalReference: string | null;
  /** Valor efetivamente aprovado, na moeda do pagamento. */
  amount: number | null;
  currency: string | null;
  paymentMethod: string | null;
  approved: boolean;
  dead: boolean;
}

function client() {
  if (!config.mercadopago.accessToken) {
    throw new GatewayError(
      'MERCADOPAGO_ACCESS_TOKEN não configurada — trilho de cartão indisponível',
      'PSP_NOT_CONFIGURED',
      false,
    );
  }
  return axios.create({
    baseURL: config.mercadopago.base,
    timeout: 15_000,
    headers: { Authorization: `Bearer ${config.mercadopago.accessToken}` },
  });
}

/**
 * Causas de erro do MP que o cliente pode resolver sozinho — traduzidas.
 *
 * O código cru ("bin_not_found") não diz nada a quem está com o cartão na mão,
 * e a pessoa tenta o mesmo cartão de novo. A tradução mais importante é a
 * primeira: em produção, cartão de TESTE não existe, e o erro que o MP devolve
 * não deixa isso óbvio.
 */
const API_ERROR_PT: Record<string, string> = {
  no_payment_method_for_provided_bin:
    'Este cartão não é aceito por esta conta. Contas do Mercado Pago processam cartões emitidos ' +
    'no próprio país — um cartão estrangeiro não encontra meio de pagamento correspondente.',
  bin_not_found:
    'Cartão não reconhecido. Se este for um cartão de teste do Mercado Pago, ele não funciona ' +
    'com credenciais de produção — use um cartão real.',
  invalid_card_number: 'Número do cartão inválido.',
  invalid_expiration_date: 'Data de validade inválida.',
  invalid_security_code: 'Código de segurança inválido.',
  invalid_parameter: 'Algum dado do pagamento está inválido.',
  'invalid card_token_id': 'A sessão do cartão expirou. Preencha os dados de novo.',
  invalid_users:
    'O pagador e o recebedor são a mesma conta do Mercado Pago — pague com outra conta.',
};

/** Erro do MP com a mensagem que a API devolveu — sem isso o 400 é opaco. */
function wrap(err: unknown, action: string): GatewayError {
  if (err instanceof AxiosError) {
    const data = err.response?.data as
      | { message?: string; error?: string; cause?: Array<{ code?: string | number; description?: string }> }
      | undefined;

    const raw = data?.message ?? data?.error ?? err.message;
    const causeCode = data?.cause?.[0]?.code;
    const friendly =
      API_ERROR_PT[String(raw)] ?? (causeCode ? API_ERROR_PT[String(causeCode)] : undefined);
    const detail = friendly ?? raw;
    const status = err.response?.status ?? 0;
    return new GatewayError(
      // Com tradução, a mensagem já é para o cliente; sem, mantemos o contexto
      // técnico para o operador achar no log.
      friendly ? detail : `Mercado Pago (${action}): ${detail}`,
      'PSP_ERROR',
      // 4xx é configuração/credencial errada: retentar não conserta.
      status >= 500 || status === 429,
      { status },
    );
  }
  return new GatewayError(
    `Mercado Pago (${action}): ${err instanceof Error ? err.message : String(err)}`,
    'PSP_ERROR',
    true,
  );
}

function toPayment(raw: Record<string, unknown>): MpPayment {
  const status = String(raw.status ?? 'unknown');
  return {
    id: String(raw.id ?? ''),
    status,
    statusDetail: raw.status_detail === undefined ? null : String(raw.status_detail),
    externalReference:
      raw.external_reference === undefined || raw.external_reference === null
        ? null
        : String(raw.external_reference),
    // `transaction_amount` é o cobrado; o líquido (menos a taxa do MP) está em
    // `transaction_details.net_received_amount` e NÃO é o que lastreia a ordem.
    amount: raw.transaction_amount === undefined ? null : Number(raw.transaction_amount),
    currency: raw.currency_id === undefined ? null : String(raw.currency_id),
    paymentMethod: raw.payment_method_id === undefined ? null : String(raw.payment_method_id),
    approved: APPROVED.has(status),
    dead: DEAD.has(status),
  };
}

// ─────────────────────────── Criação do checkout ───────────────────────────

export interface PreferenceResult {
  preferenceId: string;
  /** Link para onde o cliente vai pagar. */
  checkoutUrl: string;
  sandbox: boolean;
}

/**
 * Cria a preferência de checkout para uma intenção.
 *
 * `external_reference` é a nossa referência (GW-XXXXXX) — é por ela que o
 * pagamento volta a encontrar a intenção, tanto no webhook quanto na consulta.
 */
export async function createPreference(input: {
  reference: string;
  title: string;
  amount: number;
  currency: string;
  payerEmail?: string | undefined;
}): Promise<PreferenceResult> {
  const base = config.mercadopago.publicBaseUrl.replace(/\/+$/, '');
  const backUrl = base ? `${base}/pay?ref=${encodeURIComponent(input.reference)}` : undefined;

  const body: Record<string, unknown> = {
    items: [
      {
        id: input.reference,
        title: input.title,
        quantity: 1,
        unit_price: Number(input.amount.toFixed(2)),
        currency_id: input.currency,
      },
    ],
    external_reference: input.reference,
    // Uma preferência por intenção: sem isto, dois clientes com o mesmo valor
    // compartilhariam checkout e o pagamento voltaria sem saber de quem é.
    ...(backUrl
      ? {
          back_urls: { success: backUrl, pending: backUrl, failure: backUrl },
          auto_return: 'approved',
        }
      : {}),
    ...(base ? { notification_url: `${base}/pay/mercadopago/webhook` } : {}),
    ...(input.payerEmail ? { payer: { email: input.payerEmail } } : {}),
  };

  try {
    const { data } = await client().post<Record<string, unknown>>('/checkout/preferences', body);
    const sandbox = config.mercadopago.sandbox;
    const init = String(data.init_point ?? '');
    const sandboxInit = String(data.sandbox_init_point ?? '');
    const checkoutUrl = sandbox ? sandboxInit || init : init || sandboxInit;

    if (!checkoutUrl) {
      throw new GatewayError(
        'Mercado Pago não devolveu link de checkout',
        'PSP_ERROR',
        true,
        data,
      );
    }

    log.info(
      { reference: input.reference, preferenceId: data.id, sandbox },
      'preferência de checkout criada',
    );
    return { preferenceId: String(data.id ?? ''), checkoutUrl, sandbox };
  } catch (err) {
    if (err instanceof GatewayError) throw err;
    throw wrap(err, 'criar preferência');
  }
}

// ─────────────────── Cobrança direta (Checkout Transparente) ───────────────────

export interface CardPaymentInput {
  /** Nossa referência. Vira `external_reference` e chave de idempotência. */
  reference: string;
  /** Valor a cobrar. Vem SEMPRE da intenção no banco, nunca do navegador. */
  amount: number;
  description: string;
  /** Token gerado pelo SDK do MP no navegador. O cartão em si nunca chega aqui. */
  token: string;
  paymentMethodId: string;
  installments: number;
  issuerId?: string | undefined;
  payerEmail: string;
  payerDocType?: string | undefined;
  payerDocNumber?: string | undefined;
}

/**
 * Cobra o cartão com o token vindo do Brick.
 *
 * O que este método **não** recebe: número do cartão, CVV, validade. O
 * navegador troca esses dados por um token direto com o MP, e é só o token que
 * passa por aqui — é o que mantém o servidor fora do escopo PCI-DSS de quem
 * armazena ou trafega dado de cartão.
 *
 * `X-Idempotency-Key` é a referência da intenção: dois cliques no botão, ou um
 * retry de rede, resultam em UMA cobrança. Sem isso o cliente pagaria duas
 * vezes pelo mesmo depósito — o erro mais caro possível neste fluxo.
 */
export async function createCardPayment(input: CardPaymentInput): Promise<MpPayment> {
  const base = config.mercadopago.publicBaseUrl.replace(/\/+$/, '');

  const body: Record<string, unknown> = {
    transaction_amount: Number(input.amount.toFixed(2)),
    token: input.token,
    description: input.description,
    installments: input.installments,
    payment_method_id: input.paymentMethodId,
    external_reference: input.reference,
    ...(input.issuerId ? { issuer_id: input.issuerId } : {}),
    ...(base ? { notification_url: `${base}/pay/mercadopago/webhook` } : {}),
    payer: {
      email: input.payerEmail,
      ...(input.payerDocType && input.payerDocNumber
        ? {
            identification: { type: input.payerDocType, number: input.payerDocNumber },
          }
        : {}),
    },
  };

  try {
    const { data } = await client().post<Record<string, unknown>>('/v1/payments', body, {
      headers: { 'X-Idempotency-Key': `pay_${input.reference}` },
    });
    const payment = toPayment(data);
    log.info(
      {
        reference: input.reference,
        paymentId: payment.id,
        status: payment.status,
        statusDetail: payment.statusDetail,
      },
      'cobrança de cartão processada',
    );
    return payment;
  } catch (err) {
    throw wrap(err, 'cobrar cartão');
  }
}

export interface PixCharge {
  payment: MpPayment;
  /** Payload copia e cola — é o que o app do banco lê. */
  copyPaste: string;
  /** PNG do QR em base64, como o MP devolve. */
  qrBase64: string | null;
  expiresAt: Date | null;
}

/**
 * Cria uma cobrança Pix com QR.
 *
 * Vantagem sobre o cartão, e não é pequena: Pix liquida na hora. O dinheiro
 * está na conta do operador em segundos, em vez de ficar retido por semanas
 * como uma venda no cartão — o que muda diretamente o tamanho do float que ele
 * precisa manter parado.
 *
 * Não há dado sensível envolvido: o cliente paga no app do banco dele. O que
 * volta para nós é um QR e um id de pagamento.
 */
export async function createPixPayment(input: {
  reference: string;
  amount: number;
  description: string;
  payerEmail: string;
  payerFirstName?: string | undefined;
  payerDocNumber?: string | undefined;
  /** Minutos até o QR expirar. */
  expiresInMinutes?: number | undefined;
}): Promise<PixCharge> {
  const base = config.mercadopago.publicBaseUrl.replace(/\/+$/, '');
  const expiresAt = new Date(Date.now() + (input.expiresInMinutes ?? 30) * 60_000);

  const body: Record<string, unknown> = {
    transaction_amount: Number(input.amount.toFixed(2)),
    description: input.description,
    payment_method_id: 'pix',
    external_reference: input.reference,
    // O MP recusa QR sem prazo em algumas contas; e um QR eterno é uma
    // cobrança que o cliente paga depois de a cotação já ter mudado.
    date_of_expiration: expiresAt.toISOString(),
    ...(base ? { notification_url: `${base}/pay/mercadopago/webhook` } : {}),
    payer: {
      email: input.payerEmail,
      ...(input.payerFirstName ? { first_name: input.payerFirstName } : {}),
      ...(input.payerDocNumber
        ? { identification: { type: 'CPF', number: input.payerDocNumber } }
        : {}),
    },
  };

  try {
    const { data } = await client().post<Record<string, unknown>>('/v1/payments', body, {
      headers: { 'X-Idempotency-Key': `pix_${input.reference}` },
    });

    const poi = data.point_of_interaction as
      | { transaction_data?: { qr_code?: string; qr_code_base64?: string } }
      | undefined;
    const copyPaste = poi?.transaction_data?.qr_code ?? '';

    if (!copyPaste) {
      throw new GatewayError(
        'Mercado Pago não devolveu o código Pix — a conta pode não ter Pix habilitado',
        'PSP_ERROR',
        false,
      );
    }

    const payment = toPayment(data);
    log.info({ reference: input.reference, paymentId: payment.id }, 'cobrança Pix criada');

    return {
      payment,
      copyPaste,
      qrBase64: poi?.transaction_data?.qr_code_base64 ?? null,
      expiresAt,
    };
  } catch (err) {
    if (err instanceof GatewayError) throw err;
    throw wrap(err, 'criar cobrança Pix');
  }
}

/**
 * Traduz o `status_detail` do MP para uma frase que o cliente entenda.
 *
 * O texto cru ("cc_rejected_bad_filled_security_code") não ajuda ninguém, e
 * "pagamento recusado" sem motivo faz o cliente tentar o mesmo cartão de novo.
 */
export function explainRejection(payment: MpPayment): string {
  const map: Record<string, string> = {
    cc_rejected_bad_filled_card_number: 'Número do cartão incorreto.',
    cc_rejected_bad_filled_date: 'Data de validade incorreta.',
    cc_rejected_bad_filled_other: 'Algum dado do cartão está incorreto.',
    cc_rejected_bad_filled_security_code: 'Código de segurança (CVV) incorreto.',
    cc_rejected_blacklist: 'Cartão recusado pelo emissor. Use outro cartão.',
    cc_rejected_call_for_authorize: 'O seu banco precisa autorizar este valor. Ligue para ele e tente de novo.',
    cc_rejected_card_disabled: 'Cartão desabilitado. Fale com o seu banco.',
    cc_rejected_duplicated_payment: 'Este pagamento já foi feito.',
    cc_rejected_high_risk: 'Pagamento recusado por análise de risco. Tente outro meio.',
    cc_rejected_insufficient_amount: 'Saldo ou limite insuficiente.',
    cc_rejected_invalid_installments: 'Esse número de parcelas não é aceito para este cartão.',
    cc_rejected_max_attempts: 'Muitas tentativas. Use outro cartão.',
    cc_rejected_card_type_not_allowed: 'Tipo de cartão não aceito.',
  };
  const detail = payment.statusDetail ?? '';
  if (map[detail]) return map[detail]!;
  if (payment.status === 'in_process') {
    return 'Pagamento em análise pelo Mercado Pago. Assim que for aprovado, esta página segue sozinha.';
  }
  return `Pagamento não aprovado (${payment.status}${detail ? `: ${detail}` : ''}).`;
}

// ─────────────────────────── Leitura de pagamento ───────────────────────────

export async function getPayment(paymentId: string): Promise<MpPayment> {
  try {
    const { data } = await client().get<Record<string, unknown>>(
      `/v1/payments/${encodeURIComponent(paymentId)}`,
    );
    return toPayment(data);
  } catch (err) {
    throw wrap(err, `consultar pagamento ${paymentId}`);
  }
}

/**
 * Procura um pagamento pela nossa referência.
 *
 * É o caminho que não depende de webhook — usado pelo poll da página e pelo
 * tick do cron. Devolve o aprovado, se houver; senão, o mais recente, para o
 * painel poder mostrar "recusado" em vez de silêncio.
 */
export async function findPaymentByReference(reference: string): Promise<MpPayment | null> {
  try {
    const { data } = await client().get<{ results?: Array<Record<string, unknown>> }>(
      '/v1/payments/search',
      { params: { external_reference: reference, sort: 'date_created', criteria: 'desc' } },
    );
    const results = (data.results ?? []).map(toPayment);
    if (results.length === 0) return null;
    return results.find((p) => p.approved) ?? results[0]!;
  } catch (err) {
    throw wrap(err, `procurar pagamento de ${reference}`);
  }
}

/**
 * Pagamentos APROVADOS recentes na conta, com ou sem referência nossa.
 *
 * É a pergunta "o que entrou na conta?", feita ao PSP em vez de ao nosso
 * banco. Serve para achar dinheiro que chegou e o sistema não sabe atribuir —
 * QR pago depois do prazo, cliente que pagou duas vezes, cobrança criada por
 * fora. Sem isto, esse dinheiro fica invisível até alguém conferir o extrato
 * à mão.
 */
export async function listApprovedPayments(days = 7, limit = 50): Promise<MpPayment[]> {
  try {
    const { data } = await client().get<{ results?: Array<Record<string, unknown>> }>(
      '/v1/payments/search',
      {
        params: {
          sort: 'date_created',
          criteria: 'desc',
          range: 'date_created',
          begin_date: `NOW-${days}DAYS`,
          end_date: 'NOW',
          status: 'approved',
          limit,
        },
      },
    );
    return (data.results ?? []).map(toPayment);
  } catch (err) {
    throw wrap(err, 'listar pagamentos aprovados');
  }
}

// ─────────────────────────── Webhook ───────────────────────────

/**
 * Valida a assinatura do webhook do MP.
 *
 * O manifesto é fixo e sensível a formato: `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`
 * com o id em minúsculas. O header vem como `ts=...,v1=...`.
 *
 * Sem `MERCADOPAGO_WEBHOOK_SECRET` configurado, a verificação é recusada em
 * produção e apenas registrada em desenvolvimento — aceitar webhook não
 * assinado em produção seria deixar qualquer um confirmar pagamento. Mesmo
 * assim, quem confirma a ordem é a consulta à API do MP, não o corpo do
 * webhook: uma requisição forjada, no pior caso, causa uma consulta a mais.
 */
export function verifyWebhookSignature(req: Request, dataId: string): SignatureVerification {
  const secret = config.mercadopago.webhookSecret;
  if (!secret) {
    if (config.isProduction) {
      return { valid: false, reason: 'MERCADOPAGO_WEBHOOK_SECRET não configurada' };
    }
    log.warn('webhook do MP sem verificação de assinatura (dev, segredo ausente)');
    return { valid: true };
  }

  const header = req.headers['x-signature'];
  const requestId = req.headers['x-request-id'];
  if (typeof header !== 'string' || header.length === 0) {
    return { valid: false, reason: 'header x-signature ausente' };
  }

  let ts = '';
  let v1 = '';
  for (const part of header.split(',')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === 'ts') ts = value;
    else if (key === 'v1') v1 = value;
  }
  if (!ts || !v1) return { valid: false, reason: 'x-signature mal formado' };

  const manifest =
    `id:${dataId.toLowerCase()};` +
    (typeof requestId === 'string' && requestId ? `request-id:${requestId};` : '') +
    `ts:${ts};`;
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');

  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(v1, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { valid: false, reason: 'assinatura não corresponde' };
  }
  return { valid: true, timestamp: Number(ts) };
}

/** Extrai o id do pagamento de qualquer um dos formatos que o MP manda. */
export function extractPaymentId(req: Request): { id: string | null; topic: string } {
  const body = (req.body ?? {}) as {
    type?: string;
    action?: string;
    topic?: string;
    data?: { id?: string | number };
    resource?: string;
  };
  const query = req.query as { 'data.id'?: string; id?: string; topic?: string; type?: string };

  const topic = String(body.type ?? body.topic ?? query.topic ?? query.type ?? 'unknown');

  const raw =
    body.data?.id ??
    query['data.id'] ??
    query.id ??
    // Formato antigo (IPN): `resource` é a URL do recurso.
    (typeof body.resource === 'string' ? body.resource.split('/').pop() : undefined);

  return { id: raw === undefined || raw === null ? null : String(raw), topic };
}

export function isConfigured(): boolean {
  return config.mercadopago.accessToken.length > 0;
}

/**
 * O checkout embutido (Bricks) precisa da Public Key no navegador. Sem ela só
 * resta o redirecionamento para a página do MP.
 */
export function supportsEmbeddedCheckout(): boolean {
  return isConfigured() && config.mercadopago.publicKey.length > 0;
}
