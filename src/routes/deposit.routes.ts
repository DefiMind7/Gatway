import { Router, type Request, type Response } from 'express';
import { config } from '../config';
import { GatewayError } from '../types';
import {
  createIntent,
  getCheckoutOptions,
  getPublicView,
  payWithCard,
  revealWalletSecret,
  type CardFormData,
} from '../services/deposit.service';
import { pollForCustomer } from '../services/deposit-watch.service';
import {
  authenticate,
  getAccountView,
  login,
  logout,
  register,
  type AuthenticatedCustomer,
} from '../services/customer.service';
import { revealSecret } from '../services/wallet.service';
import { listWithdrawals, quoteWithdrawal, withdraw } from '../services/withdrawal.service';
import mercadopagoRoutes from './mercadopago.routes';
import { DEPOSIT_PAGE_HTML } from './deposit.page';
import { ah } from '../utils/async-route';

/**
 * Checkout público do provedor interno.
 *
 * Tudo aqui é sem autenticação por definição — é a porta de entrada do
 * dinheiro. O que segura o risco não é um segredo, é o servidor: faixa de
 * valores (`DEPOSIT_MIN/MAX_AMOUNT`), rate limit por IP no banco, teto por
 * ordem (`MAX_ORDER_INPUT_RAW`) e o fato de a confirmação nunca partir do
 * cliente — vem da chain ou do painel.
 *
 * A referência é o único "segredo" de uma intenção, e é curta de propósito
 * (é ditada por telefone). Portanto a visão pública não expõe nada que
 * justifique protegê-la: valor, trilho, estado e o rastro on-chain da própria
 * ordem do cliente.
 */

const router: Router = Router();

/**
 * Webhook e status do PSP de cartão. Fica sob `/pay` por pertencer ao mesmo
 * provedor interno — o cartão é um trilho dele, não uma integração à parte.
 */
router.use('/mercadopago', mercadopagoRoutes);

// ─────────────────────────── Conta do cliente ───────────────────────────

/** Lê o token de sessão. Header, nunca cookie: não há navegação cruzada aqui. */
function sessionToken(req: Request): string {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7).trim();
  const direct = req.headers['x-session'];
  return typeof direct === 'string' ? direct : '';
}

/** Sessão obrigatória. 401 sem detalhe: não dizemos por que falhou. */
async function requireCustomer(req: Request): Promise<AuthenticatedCustomer> {
  const auth = await authenticate(sessionToken(req));
  if (!auth) {
    throw new GatewayError('faça login para continuar', 'UNAUTHENTICATED', false);
  }
  return auth;
}

router.post('/api/auth/register', ah(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { email?: unknown; password?: unknown };
  const result = await register({
    email: body.email,
    password: String(body.password ?? ''),
    clientIp: req.ip,
  });
  res.status(201).json(result);
}));

router.post('/api/auth/login', ah(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { email?: unknown; password?: unknown };
  const result = await login({
    email: body.email,
    password: String(body.password ?? ''),
    clientIp: req.ip,
  });
  res.json(result);
}));

router.post('/api/auth/logout', ah(async (req: Request, res: Response) => {
  await logout(sessionToken(req));
  res.json({ ok: true });
}));

/** Carteira, saldo lido da chain e histórico de compras. */
router.get('/api/account', ah(async (req: Request, res: Response) => {
  res.json(await getAccountView(await requireCustomer(req)));
}));

/**
 * Exporta a chave privada da carteira da conta.
 *
 * Autenticado pela sessão — sem token na URL, e revogável. A partir daqui o
 * cliente controla o dinheiro por fora do sistema, e a entrega fica datada.
 */
router.post('/api/account/wallet/secret', ah(async (req: Request, res: Response) => {
  const auth = await requireCustomer(req);
  res.json(await revealSecret(auth.wallet.id));
}));

// ─────────────────────────── Saque ───────────────────────────

/** Quanto dá para sacar agora, já descontada a taxa de rede. */
router.get('/api/account/withdraw', ah(async (req: Request, res: Response) => {
  const auth = await requireCustomer(req);
  const [quote, history] = await Promise.all([
    quoteWithdrawal(auth.wallet.publicKey),
    listWithdrawals(auth.customer.id),
  ]);

  res.json({
    balanceSol: Number(quote.balanceLamports) / 1e9,
    maxSol: Number(quote.maxLamports) / 1e9,
    minSol: Number(quote.minLamports) / 1e9,
    history: history.map((w) => ({
      destination: w.destination,
      sol: Number(w.lamports) / 1e9,
      status: w.status,
      signature: w.signature,
      createdAt: w.createdAt.toISOString(),
    })),
  });
}));

/**
 * Envia o SOL para fora.
 *
 * Move dinheiro de verdade e é irreversível — por isso exige sessão, valida o
 * destino antes de assinar e roda sob lock por carteira. Omitir `amountSol`
 * saca tudo o que couber depois da taxa.
 */
router.post('/api/account/withdraw', ah(async (req: Request, res: Response) => {
  const auth = await requireCustomer(req);
  const body = (req.body ?? {}) as { destination?: string; amountSol?: number };

  if (typeof body.destination !== 'string') {
    throw new GatewayError('esperado { destination, amountSol? }', 'INVALID_BODY', false);
  }

  const result = await withdraw(auth, {
    destination: body.destination,
    ...(body.amountSol !== undefined ? { amountSol: Number(body.amountSol) } : {}),
    clientIp: req.ip,
  });

  res.json({
    signature: result.signature,
    sol: result.sol,
    destination: result.destination,
    explorer: result.explorer,
  });
}));

/** A página em si é estática; todo o estado vem de /pay/api/*. */
router.get('/', (_req: Request, res: Response) => {
  res.type('html').send(DEPOSIT_PAGE_HTML);
});

/** Trilhos habilitados, limites e a taxa atual — o que o formulário precisa. */
router.get('/api/options', ah(async (_req: Request, res: Response) => {
  res.json(await getCheckoutOptions());
}));

router.post('/api/intents', ah(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    method?: string;
    currency?: string;
    amount?: number;
    customerWallet?: string;
    email?: string;
    payerDocNumber?: string;
  };

  // `customerWallet` é opcional: sem ela, o gateway gera uma carteira.
  if (typeof body.method !== 'string') {
    throw new GatewayError('esperado { method, currency, amount }', 'INVALID_BODY', false);
  }

  // Com sessão, o destino é a carteira da conta; sem sessão, o fluxo avulso
  // continua valendo (carteira informada ou gerada na hora).
  const auth = await authenticate(sessionToken(req));

  const { intent, claimToken } = await createIntent({
    method: body.method,
    currency: body.currency ?? 'USD',
    amount: Number(body.amount),
    customerWallet: body.customerWallet,
    // A conta manda no e-mail do pagador; sem conta, vale o informado.
    customerEmail: auth ? auth.customer.email : body.email,
    ...(body.payerDocNumber !== undefined ? { payerDocNumber: body.payerDocNumber } : {}),
    ...(auth
      ? {
          customer: {
            id: auth.customer.id,
            walletId: auth.wallet.id,
            walletAddress: auth.wallet.publicKey,
          },
        }
      : {}),
    // `trust proxy` está ligado no app, então req.ip é o IP real atrás do LB.
    clientIp: req.ip,
  });

  const view = await getPublicView(intent.reference);

  // O token de posse sai daqui UMA vez. Não há endpoint que o devolva depois:
  // se o navegador perder, a recuperação é pelo painel do operador.
  res.status(201).json({ ...view, claimToken });
}));

/**
 * Cobrança do checkout próprio.
 *
 * Recebe o **token** do cartão gerado pelo SDK do Mercado Pago no navegador —
 * nunca número, validade ou CVV. É essa fronteira que mantém o servidor fora
 * do escopo de quem trafega dado de cartão.
 *
 * O valor cobrado vem da intenção no banco. Nada do que o navegador manda
 * decide quanto o cliente paga.
 */
router.post('/api/intents/:reference/pay', ah(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Partial<CardFormData>;

  if (typeof body.token !== 'string' || typeof body.paymentMethodId !== 'string') {
    throw new GatewayError(
      'esperado { token, paymentMethodId, payerEmail }',
      'INVALID_BODY',
      false,
    );
  }

  const outcome = await payWithCard(String(req.params.reference ?? ''), {
    token: body.token,
    paymentMethodId: body.paymentMethodId,
    installments: Number(body.installments ?? 1),
    issuerId: body.issuerId,
    payerEmail: String(body.payerEmail ?? ''),
    payerDocType: body.payerDocType,
    payerDocNumber: body.payerDocNumber,
  });

  // 402 num cartão recusado: é falha do pagamento, não da requisição.
  return res.status(outcome.status === 'rejected' ? 402 : 200).json(outcome);
}));

/**
 * Entrega da chave privada da carteira gerada.
 *
 * Exige o token de posse no header `x-claim-token` — a referência sozinha não
 * abre a carteira. POST, e não GET, para a chave não acabar em log de acesso,
 * histórico ou referrer.
 */
router.post('/api/intents/:reference/wallet', ah(async (req: Request, res: Response) => {
  const header = req.headers['x-claim-token'];
  const token = typeof header === 'string' ? header : '';

  const secret = await revealWalletSecret(String(req.params.reference ?? ''), token);
  res.json(secret);
}));

/**
 * Estado de uma intenção — e, de carona, o motor do trilho automático.
 *
 * O poll do cliente é o que dispara a varredura on-chain e, em serverless,
 * empurra a pipeline de uma ordem que ficou pelo caminho. Ver
 * `pollForCustomer`: é a resposta ao fato de não existir processo de fundo
 * entre requisições nesse runtime.
 */
router.get('/api/intents/:reference', ah(async (req: Request, res: Response) => {
  const reference = String(req.params.reference ?? '');
  const { view } = await pollForCustomer(reference);
  res.json(view);
}));

/** Só para diagnóstico do operador: o checkout está de pé e com quais trilhos. */
router.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    enabled: config.deposit.enabled,
    methods: config.deposit.methods,
    autoConfirm: config.deposit.autoConfirm,
  });
});

export default router;
