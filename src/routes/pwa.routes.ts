import { Router, type Request, type Response } from 'express';
import { ICON_192_BASE64, ICON_512_BASE64 } from './pwa-icons';

/**
 * Instalação na tela inicial (PWA), para Android e iOS.
 *
 * Por que PWA e não app nativo: um MVP que precisa chegar hoje na mão de
 * poucas pessoas não sobrevive a duas builds nativas, duas contas de loja e
 * ciclos de revisão. Instalado, o resultado é o mesmo que importa — ícone na
 * tela inicial, abre em tela cheia sem barra de navegador, atualiza sozinho a
 * cada deploy.
 *
 * São dois manifestos porque são dois aplicativos diferentes: o cliente
 * instala o checkout, o operador instala o painel. Compartilhar um manifesto
 * faria os dois abrirem na mesma tela.
 */

const router: Router = Router();

/** Cache longo: o ícone só muda quando o código muda. */
function sendIcon(res: Response, base64: string): void {
  const buffer = Buffer.from(base64, 'base64');
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
  res.send(buffer);
}

router.get('/icon-192.png', (_req: Request, res: Response) => sendIcon(res, ICON_192_BASE64));
router.get('/icon-512.png', (_req: Request, res: Response) => sendIcon(res, ICON_512_BASE64));

/** Manifesto do checkout — o que o cliente instala. */
router.get('/app.webmanifest', (_req: Request, res: Response) => {
  res.type('application/manifest+json').json({
    name: 'Depositar — SOL na sua carteira',
    short_name: 'Depositar',
    description: 'Deposite em reais e receba SOL na sua carteira Solana.',
    start_url: '/pay',
    scope: '/pay',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0f1216',
    theme_color: '#0f1216',
    lang: 'pt-BR',
    icons: [
      { src: '/pwa/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/pwa/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/pwa/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  });
});

/** Manifesto do painel — o que o operador instala. */
router.get('/admin.webmanifest', (_req: Request, res: Response) => {
  res.type('application/manifest+json').json({
    name: 'Gateway — Painel do operador',
    short_name: 'Painel',
    description: 'Fila de entrega, livro-razão e controle do gateway.',
    start_url: '/admin',
    scope: '/admin',
    display: 'standalone',
    background_color: '#0f1216',
    theme_color: '#0f1216',
    lang: 'pt-BR',
    icons: [
      { src: '/pwa/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/pwa/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/pwa/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  });
});

/**
 * Service worker mínimo.
 *
 * Deliberadamente NÃO faz cache de nada: este app mostra saldo, fila de
 * pagamento e estado de ordem — dado velho aqui é pior do que tela de erro.
 * Ele existe porque o Android exige um service worker registrado para
 * oferecer "instalar aplicativo".
 */
router.get('/sw.js', (_req: Request, res: Response) => {
  res.type('application/javascript').send(
    [
      "self.addEventListener('install', () => self.skipWaiting());",
      "self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));",
      '// Sem cache: sempre rede. Ver comentário em pwa.routes.ts.',
      "self.addEventListener('fetch', () => {});",
    ].join('\n'),
  );
});

export default router;
