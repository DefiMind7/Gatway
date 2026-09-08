import express, { Router, type Request, type Response } from 'express';
import { config } from '../config';
import { prisma } from '../database/client';
import { GatewayError } from '../types';
import { logger } from '../utils/logger';
import { createIntent } from '../services/deposit.service';
import { findPublished } from '../services/site-builder.service';
import { MerchantStatus } from '../services/merchant-account.service';
import { ah } from '../utils/async-route';

/**
 * Sites das lojas — `/s/:slug`.
 *
 * Este arquivo serve HTML que NÓS NÃO ESCREVEMOS: veio de um modelo, guiado
 * por um texto livre da loja. Tratá-lo como conteúdo confiável seria hospedar
 * o código de terceiros na mesma origem do portal e do checkout — e aí uma
 * linha de JavaScript numa loja qualquer leria o `localStorage` e sairia com a
 * sessão de quem estivesse logado.
 *
 * A defesa é a diretiva `sandbox` do CSP, que joga a página numa origem opaca
 * própria. De lá ela não enxerga nosso armazenamento, não faz requisição
 * autenticada em nosso nome, e não alcança nada que seja de outra loja.
 *
 * O preço do sandbox é que a página fica sem canal de rede para conversar com
 * a nossa API — e é por isso que o botão de comprar é um `form` que posta
 * aqui. Além de contornar o isolamento pela porta da frente, isso resolve o
 * problema que qualquer loja estática tem: a chave de API não desce para o
 * navegador, porque quem cria a cobrança é o servidor.
 */

const router: Router = Router();
const log = logger.child({ scope: 'site' });

/**
 * O cinto e o suspensório da página gerada.
 *
 * `sandbox` é o que importa: origem opaca. As permissões liberadas são as
 * mínimas para uma vitrine funcionar — script para interatividade, form e
 * navegação para o botão de comprar levar ao checkout.
 *
 * `form-action 'self'` impede que uma página gerada mande dados do visitante
 * para fora. Sem essa linha, um prompt mal-intencionado poderia montar uma
 * tela de "confirme seus dados" que posta em outro servidor.
 */
const CSP = [
  "sandbox allow-scripts allow-forms allow-popups allow-top-navigation-by-user-activation",
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "form-action 'self'",
  "base-uri 'none'",
].join('; ');

function servirHtml(res: Response, html: string): void {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // Loja é conteúdo público, mas não queremos cache agressivo atrapalhando
  // quem acabou de publicar uma versão nova.
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.type('html').send(html);
}

const NAO_ENCONTRADO = `<!doctype html>
<html lang="pt"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Loja não encontrada</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1216;
color:#94a1b2;font:15px/1.6 ui-sans-serif,system-ui,sans-serif;text-align:center;padding:24px}
b{display:block;color:#e6eaef;font-size:18px;margin-bottom:6px}</style></head>
<body><div><b>Esta loja não está no ar</b>O endereço pode ter mudado, ou a loja ainda não publicou.</div></body></html>`;

/** A vitrine. */
router.get('/:slug', ah(async (req: Request, res: Response) => {
  const encontrado = await findPublished(String(req.params.slug ?? ''));
  if (!encontrado) {
    res.status(404);
    servirHtml(res, NAO_ENCONTRADO);
    return;
  }
  servirHtml(res, encontrado.site.publishedHtml!);
}));

/**
 * O botão de comprar.
 *
 * Vem como formulário porque a página está isolada e não tem como chamar a
 * nossa API por fetch. O servidor cria a cobrança em nome da loja e devolve o
 * comprador ao checkout hospedado, onde ele escolhe Pix ou cartão.
 */
router.post(
  '/:slug/checkout',
  express.urlencoded({ extended: false, limit: '16kb' }),
  ah(async (req: Request, res: Response) => {
    const slug = String(req.params.slug ?? '');
    const encontrado = await findPublished(slug);
    if (!encontrado) {
      res.status(404);
      servirHtml(res, NAO_ENCONTRADO);
      return;
    }

    const { merchant } = encontrado;
    if (merchant.status !== MerchantStatus.APROVADO) {
      throw new GatewayError(
        'esta loja ainda não está habilitada a receber pagamentos',
        'NOT_APPROVED',
        false,
      );
    }

    const body = (req.body ?? {}) as { amount?: string; item?: string };
    const valor = Number(String(body.amount ?? '').replace(',', '.'));
    if (!Number.isFinite(valor) || valor <= 0) {
      throw new GatewayError('valor do produto inválido', 'INVALID_AMOUNT', false);
    }

    const item = String(body.item ?? '').trim().slice(0, 120) || 'Compra';

    const { intent } = await createIntent({
      method: 'PIXQR',
      currency: 'BRL',
      amount: valor,
      customerEmail: merchant.email,
      clientIp: req.ip,
    });

    // O vínculo com a loja é o que faz a venda cair no livro-razão dela — o
    // mesmo caminho de uma cobrança criada pela API.
    await prisma.depositIntent.update({
      where: { id: intent.id },
      data: { merchantId: merchant.id, merchantExternalId: item },
    });

    log.info(
      { merchantId: merchant.id, slug, reference: intent.reference, valor },
      'compra iniciada pela loja gerada',
    );

    const base = config.mercadopago.publicBaseUrl.replace(/\/+$/, '');
    res.redirect(303, `${base}/pay?ref=${intent.reference}`);
  }),
);

export default router;
