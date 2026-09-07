import express, { type Application, type NextFunction, type Request, type Response } from 'express';
import pinoHttp from 'pino-http';
import { config } from './config';
import { logger } from './utils/logger';
import { GatewayError, type RawBodyRequest } from './types';
import adminRoutes from './routes/admin.routes';
import depositRoutes from './routes/deposit.routes';
import pwaRoutes from './routes/pwa.routes';
import apiRoutes from './routes/api.routes';
import { DOCS_PAGE_HTML } from './routes/docs.page';
import { PARTNER_PAGE_HTML } from './routes/partner.page';
import { HOME_PAGE_HTML } from './routes/home.page';
import { ACCOUNT_PAGE_HTML } from './routes/account.page';
import { HUB_PAGE_HTML } from './routes/hub.page';
import merchantRoutes from './routes/merchant.routes';
import healthRoutes from './routes/health.routes';
import quoteRoutes from './routes/quote.routes';
import webhookRoutes from './routes/webhook.routes';

export function createApp(): Application {
  const app = express();

  app.disable('x-powered-by');
  // Respeita X-Forwarded-* atrás de proxy/LB (req.ip correto nos logs).
  app.set('trust proxy', true);

  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url === '/health' },
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
    }),
  );

  /**
   * O HMAC do webhook é calculado sobre os bytes exatos recebidos. Se
   * deixássemos o Express re-serializar o JSON, qualquer diferença de
   * espaçamento ou ordem de chaves invalidaria assinaturas legítimas — por
   * isso guardamos o buffer cru aqui.
   */
  app.use(
    express.json({
      limit: '256kb',
      verify: (req, _res, buf) => {
        (req as Request & RawBodyRequest).rawBody = Buffer.from(buf);
      },
    }),
  );

  app.use('/health', healthRoutes);
  app.use('/webhook', webhookRoutes);
  app.use('/quote', quoteRoutes);
  // Checkout público do provedor interno de depósitos.
  app.use('/pay', depositRoutes);
  // Manifesto, ícones e service worker — instalação na tela inicial.
  app.use('/pwa', pwaRoutes);
  // API das lojas integradas.
  app.use('/api/v1', apiRoutes);
  // Documentação da API — pública, é o que a loja lê antes de integrar.
  app.get('/docs', (_req, res) => {
    res.type('html').send(DOCS_PAGE_HTML);
  });

  /**
   * O funil de entrada: raiz -> conta -> hub.
   *
   * A raiz é pública e vende; `/conta` cria ou abre a sessão da pessoa; só em
   * `/inicio` aparece a escolha entre comprar e vender. A ordem importa porque
   * as duas operações precisam de conta para fazer qualquer coisa — oferecer a
   * escolha antes do login era mostrar três caminhos que davam todos no mesmo
   * formulário, só que depois de a pessoa já ter escolhido.
   *
   * As páginas são estáticas: quem manda para /conta quando não há sessão é o
   * próprio JS delas, ao ver que não tem token. Redirecionar no servidor não
   * daria — o token vive no localStorage, e o servidor não o enxerga.
   */
  app.get('/', (_req, res) => {
    res.type('html').send(HOME_PAGE_HTML);
  });
  app.get('/conta', (_req, res) => {
    res.type('html').send(ACCOUNT_PAGE_HTML);
  });
  app.get('/inicio', (_req, res) => {
    res.type('html').send(HUB_PAGE_HTML);
  });

  // Portal da loja: faturamento e saque. Separado do painel do operador.
  app.use('/loja', merchantRoutes);

  // Candidatura de lojas — a porta de entrada comercial.
  app.get('/parceiros', (_req, res) => {
    res.type('html').send(PARTNER_PAGE_HTML);
  });
  app.use('/admin', adminRoutes);

  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found', path: req.path });
  });

  // Handler de erro final. A assinatura de 4 args é obrigatória para o Express
  // reconhecê-lo como error handler.
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const isGatewayError = err instanceof GatewayError;
    const status = isGatewayError && !err.retryable ? 400 : 500;
    const message = err instanceof Error ? err.message : 'erro interno';

    req.log?.error({ err, code: isGatewayError ? err.code : 'INTERNAL' }, 'requisição falhou');

    res.status(status).json({
      error: isGatewayError ? err.code : 'internal_error',
      // Em produção não devolvemos detalhe interno de erro não-tipado.
      message: isGatewayError || !config.isProduction ? message : 'erro interno',
    });
  });

  return app;
}
