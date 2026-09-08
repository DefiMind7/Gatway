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
  MOEDAS_SAQUE,
  requestWithdrawal,
} from '../services/merchant-ledger.service';
import {
  changePassword,
  issueApiKey,
  listNotifications,
  listSessions,
  login,
  logout,
  markNotificationsRead,
  MerchantStatus,
  openStoreForCustomer,
  requestPasswordReset,
  resolveSession,
  revokeOtherSessions,
  rotateWebhookSecret,
  signUp,
  storeOfCustomer,
  updateProfile,
} from '../services/merchant-account.service';
import { authenticate as authenticateCustomer } from '../services/customer.service';
import { submitApplication, VOLUMES_ACEITOS } from '../services/application.service';
import {
  clearAiKey,
  generateSite,
  getSite,
  publishSite,
  setAiKey,
  unpublishSite,
} from '../services/site-builder.service';
import { config } from '../config';
import { MERCHANT_PAGE_HTML } from './merchant.page';
import { ah } from '../utils/async-route';

/**
 * Portal da loja — `/loja`.
 *
 * É onde o dono da loja cria a conta, pede a análise, recebe a resposta, emite
 * a chave, acompanha o faturamento e pede saque. Separado do painel do
 * operador de propósito: são pessoas diferentes, com poderes diferentes, e
 * misturar as duas telas seria a forma mais rápida de dar a uma loja acesso ao
 * que não é dela.
 *
 * A autenticação é por sessão, não pela chave de API: a chave é do servidor da
 * loja e vive em configuração; o portal é do humano e vive no navegador. Usar
 * a mesma credencial para os dois significaria que qualquer pessoa com acesso
 * ao código da loja poderia sacar o dinheiro dela.
 */

const router: Router = Router();
const log = logger.child({ scope: 'merchant.portal' });

function tokenDaRequisicao(req: Request): string {
  const header = req.headers['x-merchant-session'];
  return typeof header === 'string' ? header : '';
}

/** Sessão da PESSOA (a mesma do checkout). Vem do funil de entrada. */
function tokenDaPessoa(req: Request): string {
  const header = req.headers['x-session'];
  return typeof header === 'string' ? header : '';
}

interface Sessao {
  loja: Merchant;
  /** Token da sessão da loja. Vazio quando quem entrou foi a pessoa. */
  token: string;
}

/**
 * Duas portas para o mesmo portal.
 *
 * A da PESSOA é a do funil: ela entrou uma vez em /conta e a loja dela é uma
 * consequência disso. A da LOJA é a de quem tem login próprio — lojas criadas
 * pelo operador, e as que existiam antes do funil. Manter as duas é o que
 * evita trancar do lado de fora quem já estava dentro.
 */
async function exigirLoja(req: Request): Promise<Sessao> {
  /*
   * A pessoa vem primeiro, e só quando ela de fato tem loja.
   *
   * A ordem importa porque os dois tokens convivem no mesmo navegador: quem
   * entrou uma vez pelo login antigo da loja e depois criou conta pessoal fica
   * com os dois guardados. Se a sessão da loja vencesse, essa pessoa abriria
   * /loja e veria a loja ERRADA — a antiga, não a dela. Preferir a pessoa
   * quando ela tem loja resolve isso sem trancar ninguém: quem só tem o login
   * próprio cai no segundo ramo como sempre.
   */
  const pessoa = await authenticateCustomer(tokenDaPessoa(req));
  const lojaDaPessoa = pessoa ? await storeOfCustomer(pessoa.customer.id) : null;

  if (lojaDaPessoa) {
    if (!lojaDaPessoa.active) {
      throw new GatewayError('esta loja está suspensa — fale com o suporte', 'SUSPENDED', false);
    }
    return { loja: lojaDaPessoa, token: '' };
  }

  const tokenLoja = tokenDaRequisicao(req);
  if (tokenLoja) {
    const loja = await resolveSession(tokenLoja);
    if (loja) return { loja, token: tokenLoja };
  }

  // Autenticada, mas ainda sem loja: é convite para abrir uma, não falha.
  if (pessoa) {
    throw new GatewayError('você ainda não abriu uma loja nesta conta', 'NO_STORE', false);
  }

  throw new GatewayError('faça login para continuar', 'UNAUTHENTICATED', false);
}

/**
 * Como `exigirLoja`, mas barra quem está com senha temporária.
 *
 * Uma senha emitida pelo operador passou por um canal que não é secreto — ele
 * a leu, digitou, mandou por alguma mensagem. Enquanto ela valer, a conta está
 * a um vazamento de distância de qualquer um: por isso a única porta aberta é
 * a troca de senha, e nada que mexa em dinheiro ou credencial.
 */
async function exigirLojaLiberada(req: Request): Promise<Sessao> {
  const sessao = await exigirLoja(req);
  if (sessao.loja.mustChangePassword) {
    throw new GatewayError(
      'troque a sua senha temporária antes de continuar',
      'PASSWORD_CHANGE_REQUIRED',
      false,
    );
  }
  return sessao;
}

/** Só lojas aprovadas cobram — e só elas emitem chave. */
function exigirAprovada(loja: Merchant): void {
  if (loja.status !== MerchantStatus.APROVADO) {
    throw new GatewayError(
      'a sua loja ainda não foi aprovada para cobrar',
      'NOT_APPROVED',
      false,
    );
  }
}

/** A página em si é estática; o estado vem de /loja/api/*. */
router.get('/', (_req: Request, res: Response) => {
  res.type('html').send(MERCHANT_PAGE_HTML);
});

// ─────────────────────────── Conta e sessão ───────────────────────────

router.post('/api/signup', ah(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { email?: string; companyName?: string; password?: string };

  await signUp({
    email: String(body.email ?? ''),
    companyName: String(body.companyName ?? ''),
    password: String(body.password ?? ''),
    clientIp: req.ip,
  });

  // Entra direto: pedir para fazer login logo depois de criar a conta é um
  // passo que só existe para o sistema, não para quem acabou de se cadastrar.
  const sessao = await login(String(body.email ?? ''), String(body.password ?? ''), req.ip);
  res.status(201).json({ token: sessao.token, name: sessao.merchant.name });
}));

router.post('/api/login', ah(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { email?: string; password?: string };
  const sessao = await login(String(body.email ?? ''), String(body.password ?? ''), req.ip);
  res.json({
    token: sessao.token,
    name: sessao.merchant.name,
    email: sessao.merchant.email,
    mustChangePassword: sessao.merchant.mustChangePassword,
  });
}));

router.post('/api/logout', ah(async (req: Request, res: Response) => {
  await logout(tokenDaRequisicao(req));
  res.json({ ok: true });
}));

/**
 * Recuperação de senha.
 *
 * Responde sempre `ok`, exista a conta ou não. Sem provedor de e-mail, o
 * pedido cai na fila do operador — a tela diz isso com todas as letras em vez
 * de fingir que mandou uma mensagem.
 */
router.post('/api/password/forgot', ah(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { email?: string };
  await requestPasswordReset(String(body.email ?? ''), req.ip);
  res.json({ ok: true });
}));

router.post('/api/password', ah(async (req: Request, res: Response) => {
  const { loja, token } = await exigirLoja(req);
  const body = (req.body ?? {}) as { current?: string; next?: string };
  await changePassword(loja, String(body.current ?? ''), String(body.next ?? ''), token);
  res.json({ ok: true });
}));

router.get('/api/sessions', ah(async (req: Request, res: Response) => {
  const { loja, token } = await exigirLojaLiberada(req);
  res.json({ sessions: await listSessions(loja.id, token) });
}));

router.post('/api/sessions/revoke', ah(async (req: Request, res: Response) => {
  const { loja, token } = await exigirLojaLiberada(req);
  res.json({ revoked: await revokeOtherSessions(loja.id, token) });
}));

/**
 * Estado da pessoa em relação a loja: tem uma? qual?
 *
 * É o que a porta "Faça vendas conosco" consulta antes de decidir se manda
 * para o painel ou para o formulário de abertura.
 */
router.get('/api/me', ah(async (req: Request, res: Response) => {
  const pessoa = await authenticateCustomer(tokenDaPessoa(req));
  if (!pessoa) {
    res.json({ authenticated: false, hasStore: false });
    return;
  }
  const loja = await storeOfCustomer(pessoa.customer.id);
  res.json({
    authenticated: true,
    email: pessoa.customer.email,
    hasStore: loja !== null,
    ...(loja ? { store: { name: loja.name, status: loja.status } } : {}),
  });
}));

/** Abre a loja desta conta. Idempotente: chamar duas vezes devolve a mesma. */
router.post('/api/open-store', ah(async (req: Request, res: Response) => {
  const pessoa = await authenticateCustomer(tokenDaPessoa(req));
  if (!pessoa) throw new GatewayError('faça login para continuar', 'UNAUTHENTICATED', false);

  const body = (req.body ?? {}) as { companyName?: string };
  const loja = await openStoreForCustomer({
    customerId: pessoa.customer.id,
    email: pessoa.customer.email,
    companyName: String(body.companyName ?? ''),
  });

  res.status(201).json({ name: loja.name, status: loja.status });
}));

// ─────────────────────────── Painel da loja ───────────────────────────

/** Estado da conta, faturamento, saldo, saques, vendas e avisos. */
router.get('/api/dashboard', ah(async (req: Request, res: Response) => {
  const { loja } = await exigirLoja(req);

  const [saldo, extrato, saques, vendas, avisos, pedido] = await Promise.all([
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
    listNotifications(loja.id, 30),
    prisma.merchantApplication.findFirst({
      where: { merchantId: loja.id },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  res.json({
    merchant: {
      name: loja.name,
      email: loja.email,
      legalName: loja.legalName,
      taxId: loja.taxId,
      phone: loja.phone,
      website: loja.website,
      status: loja.status,
      active: loja.active,
      mustChangePassword: loja.mustChangePassword,
      /// true quando o acesso é pela conta da pessoa: aí senha e dispositivos
      /// são de lá, e o painel da loja não deve oferecer os dois.
      ownedByPerson: loja.ownerId !== null,
      payoutWallet: loja.payoutWallet,
      preferredPayout: loja.preferredPayout,
      payoutCurrency: loja.payoutCurrency,
      payoutFiatDetails: loja.payoutFiatDetails,
      currencies: MOEDAS_SAQUE,
      volumes: VOLUMES_ACEITOS,
      commissionBps: loja.commissionBps,
      apiKeyPrefix: loja.apiKeyPrefix,
      apiKeyIssuedAt: loja.apiKeyIssuedAt?.toISOString() ?? null,
      callbackUrl: loja.callbackUrl,
      returnUrl: loja.returnUrl,
      createdAt: loja.createdAt.toISOString(),
      lastLoginAt: loja.lastLoginAt?.toISOString() ?? null,
      passwordChangedAt: loja.passwordChangedAt?.toISOString() ?? null,
    },
    application: pedido
      ? {
          id: pedido.id,
          status: pedido.status,
          reviewNote: pedido.reviewNote,
          createdAt: pedido.createdAt.toISOString(),
          reviewedAt: pedido.reviewedAt?.toISOString() ?? null,
          expectedVolume: pedido.expectedVolume,
          description: pedido.description,
        }
      : null,
    notifications: avisos,
    unread: avisos.filter((a) => !a.read).length,
    balance: saldo,
    ledger: extrato,
    withdrawals: saques.map((s) => ({
      id: s.id,
      amount: s.amountFiat,
      status: s.status,
      method: s.payoutMethod,
      payoutCurrency: s.payoutCurrency,
      estimated: s.estimatedAmount,
      sent: s.sentAmount,
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

// ─────────────────────────── Pedido de análise ───────────────────────────

/**
 * Envia o pedido de integração.
 *
 * Atrás do login, e é essa a diferença que importa: o pedido tem dono, e a
 * resposta tem para onde ir.
 */
router.post('/api/application', ah(async (req: Request, res: Response) => {
  const { loja } = await exigirLojaLiberada(req);
  const body = (req.body ?? {}) as Record<string, string | undefined>;

  const pedido = await submitApplication({
    merchant: loja,
    companyName: String(body.companyName ?? loja.name),
    legalName: body.legalName,
    taxId: body.taxId,
    phone: body.phone,
    website: body.website,
    callbackUrl: body.callbackUrl,
    expectedVolume: body.expectedVolume,
    description: body.description,
    clientIp: req.ip,
  });

  res.status(201).json({ id: pedido.id, status: pedido.status });
}));

// ─────────────────────────── Avisos ───────────────────────────

router.post('/api/notifications/read', ah(async (req: Request, res: Response) => {
  const { loja } = await exigirLoja(req);
  const body = (req.body ?? {}) as { id?: string };
  await markNotificationsRead(loja.id, body.id);
  res.json({ ok: true });
}));

// ─────────────────────────── Integração ───────────────────────────

/**
 * Emite a chave de API — a resposta traz a chave EM CLARO, uma única vez.
 *
 * Depois daqui ela só existe como hash. É por isso que a tela obriga a copiar
 * antes de fechar: não há segunda chance, só uma nova emissão.
 */
router.post('/api/api-key', ah(async (req: Request, res: Response) => {
  const { loja } = await exigirLojaLiberada(req);
  exigirAprovada(loja);

  const { apiKey, prefix, rotated } = await issueApiKey(loja.id);
  log.warn({ merchantId: loja.id, rotated }, 'loja emitiu chave pelo portal');
  res.json({ apiKey, prefix, rotated });
}));

/** O segredo de webhook pode ser relido: a loja precisa dele em configuração. */
router.get('/api/webhook-secret', ah(async (req: Request, res: Response) => {
  const { loja } = await exigirLojaLiberada(req);
  exigirAprovada(loja);
  res.json({ webhookSecret: loja.webhookSecret });
}));

router.post('/api/webhook-secret', ah(async (req: Request, res: Response) => {
  const { loja } = await exigirLojaLiberada(req);
  exigirAprovada(loja);
  res.json({ webhookSecret: await rotateWebhookSecret(loja.id) });
}));

// ─────────────────────────── Perfil ───────────────────────────

router.post('/api/profile', ah(async (req: Request, res: Response) => {
  const { loja } = await exigirLojaLiberada(req);
  const body = (req.body ?? {}) as Record<string, string | undefined>;

  const atualizada = await updateProfile(loja.id, {
    companyName: body.companyName,
    legalName: body.legalName,
    taxId: body.taxId,
    phone: body.phone,
    website: body.website,
    callbackUrl: body.callbackUrl,
    returnUrl: body.returnUrl,
  });

  res.json({ ok: true, name: atualizada.name });
}));

/**
 * Como a loja quer receber.
 *
 * Cripto e fiat convivem: a loja guarda os dois destinos e escolhe a cada
 * saque. Forçar uma escolha única obrigaria a reconfigurar a conta toda vez
 * que ela quisesse mudar.
 */
router.post('/api/payout-settings', ah(async (req: Request, res: Response) => {
  const { loja } = await exigirLojaLiberada(req);
  const body = (req.body ?? {}) as {
    wallet?: string;
    preferred?: string;
    currency?: string;
    fiatDetails?: string;
  };

  const dados: Record<string, string> = {};

  if (body.wallet !== undefined && body.wallet.trim() !== '') {
    const carteira = body.wallet.trim();
    try {
      new PublicKey(carteira);
    } catch {
      throw new GatewayError(`carteira Solana inválida: "${carteira}"`, 'INVALID_WALLET', false);
    }
    dados.payoutWallet = carteira;
  }

  if (body.preferred !== undefined) {
    const p = body.preferred.toUpperCase();
    if (p !== 'SOL' && p !== 'FIAT') {
      throw new GatewayError('forma de recebimento inválida', 'INVALID_BODY', false);
    }
    dados.preferredPayout = p;
  }

  if (body.currency !== undefined) {
    const c = body.currency.toUpperCase();
    if (!MOEDAS_SAQUE.includes(c as never)) {
      throw new GatewayError(
        `moeda não aceita: ${c}. Use ${MOEDAS_SAQUE.join(', ')}`,
        'INVALID_CURRENCY',
        false,
      );
    }
    dados.payoutCurrency = c;
  }

  if (body.fiatDetails !== undefined) {
    dados.payoutFiatDetails = body.fiatDetails.trim().slice(0, 500);
  }

  const atualizada = await prisma.merchant.update({ where: { id: loja.id }, data: dados });
  log.info({ merchantId: loja.id }, 'loja atualizou as preferências de recebimento');

  res.json({
    ok: true,
    payoutWallet: atualizada.payoutWallet,
    preferredPayout: atualizada.preferredPayout,
    payoutCurrency: atualizada.payoutCurrency,
    payoutFiatDetails: atualizada.payoutFiatDetails,
  });
}));

/**
 * Pedido de saque.
 *
 * O valor sai do saldo no ato do pedido — ver `requestWithdrawal`. A conversão
 * para SOL acontece só na aprovação do operador, pela cotação daquele momento.
 */
router.post('/api/withdrawals', ah(async (req: Request, res: Response) => {
  const { loja } = await exigirLojaLiberada(req);
  const body = (req.body ?? {}) as {
    amount?: number;
    method?: string;
    wallet?: string;
    currency?: string;
    fiatDetails?: string;
  };

  const resultado = await requestWithdrawal({
    merchant: loja,
    amountFiat: Number(body.amount),
    payoutMethod: body.method,
    destinationWallet: body.wallet,
    payoutCurrency: body.currency,
    payoutDetails: body.fiatDetails,
    clientIp: req.ip,
  });

  res.status(201).json(resultado);
}));

// ─────────────────────────── Construtor de site ───────────────────────────

/**
 * A chave da Anthropic é da loja.
 *
 * Entra por aqui, sai daqui cifrada, e nunca mais é devolvida em claro — a
 * tela mostra só os últimos caracteres, o bastante para a pessoa reconhecer
 * qual chave está guardada.
 */
router.post('/api/ai-key', ah(async (req: Request, res: Response) => {
  const { loja } = await exigirLojaLiberada(req);
  const body = (req.body ?? {}) as { key?: string };
  const hint = await setAiKey(loja.id, String(body.key ?? ''));
  res.json({ ok: true, hint });
}));

router.delete('/api/ai-key', ah(async (req: Request, res: Response) => {
  const { loja } = await exigirLojaLiberada(req);
  await clearAiKey(loja.id);
  res.json({ ok: true });
}));

/** Estado do site: rascunho, publicado, endereço. */
router.get('/api/site', ah(async (req: Request, res: Response) => {
  const { loja } = await exigirLojaLiberada(req);
  const site = await getSite(loja.id);
  const base = config.mercadopago.publicBaseUrl.replace(/\/+$/, '');

  res.json({
    hasAiKey: loja.aiKeyEnc !== null,
    aiKeyHint: loja.aiKeyHint,
    site: site
      ? {
          slug: site.slug,
          url: `${base}/s/${site.slug}`,
          prompt: site.prompt,
          hasDraft: site.draftHtml !== null,
          published: site.published,
          publishedAt: site.publishedAt?.toISOString() ?? null,
          generations: site.generations,
          /// true quando o rascunho difere do que está no ar: é o que o painel
          /// usa para avisar que há mudança esperando publicação.
          pending: site.draftHtml !== null && site.draftHtml !== site.publishedHtml,
        }
      : null,
  });
}));

/**
 * Gera o site.
 *
 * Demora: são dezenas de milhares de tokens saindo do modelo. O cliente da
 * página espera com o botão travado, e o timeout do axios é generoso de
 * propósito — cortar no meio desperdiçaria tokens que a loja já pagou.
 */
router.post('/api/site/generate', ah(async (req: Request, res: Response) => {
  const { loja } = await exigirLojaLiberada(req);
  exigirAprovada(loja);

  const body = (req.body ?? {}) as { prompt?: string };
  const base = config.mercadopago.publicBaseUrl.replace(/\/+$/, '');
  const { site, usage } = await generateSite(loja, String(body.prompt ?? ''), base);

  res.json({
    slug: site.slug,
    url: `${base}/s/${site.slug}`,
    generations: site.generations,
    usage,
  });
}));

/**
 * O rascunho, para a loja ver antes de pôr no ar.
 *
 * Devolvido como JSON, e não como página: a rota exige sessão, e um link
 * comum aberto em aba nova não teria como mandar o cabeçalho. O painel busca
 * o HTML autenticado e o injeta num iframe com `sandbox`, que é o que lhe dá
 * origem opaca — sem esse atributo o rascunho rodaria dentro da nossa origem,
 * com o painel logado do outro lado.
 */
router.get('/api/site/preview', ah(async (req: Request, res: Response) => {
  const { loja } = await exigirLojaLiberada(req);
  const site = await getSite(loja.id);
  if (!site?.draftHtml) throw new GatewayError('nenhum rascunho ainda', 'NO_DRAFT', false);
  res.json({ html: site.draftHtml });
}));

router.post('/api/site/publish', ah(async (req: Request, res: Response) => {
  const { loja } = await exigirLojaLiberada(req);
  exigirAprovada(loja);
  const site = await publishSite(loja.id);
  const base = config.mercadopago.publicBaseUrl.replace(/\/+$/, '');
  log.warn({ merchantId: loja.id, slug: site.slug }, 'loja publicou o site');
  res.json({ ok: true, url: `${base}/s/${site.slug}` });
}));

router.post('/api/site/unpublish', ah(async (req: Request, res: Response) => {
  const { loja } = await exigirLojaLiberada(req);
  await unpublishSite(loja.id);
  res.json({ ok: true });
}));

export default router;
