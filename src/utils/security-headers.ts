import type { NextFunction, Request, Response } from 'express';

/**
 * Cabeçalhos de segurança das NOSSAS páginas.
 *
 * Não havia nenhum. A cifra dos dados em repouso estava certa, mas o navegador
 * não recebia instrução alguma sobre o que podia fazer com as nossas telas — e
 * é no navegador que mora o ataque mais barato contra um checkout.
 *
 * O que cada linha impede, concretamente:
 *
 *  • **frame-ancestors / X-Frame-Options**: alguém embutir o nosso checkout
 *    num iframe invisível sob a página dele e capturar cliques do visitante
 *    (clickjacking). Num fluxo de pagamento isso vale dinheiro;
 *  • **HSTS**: a primeira requisição em http ser interceptada e nunca chegar
 *    ao https. Vale para o domínio inteiro depois da primeira visita;
 *  • **CSP**: um script de origem inesperada ser executado nas nossas telas —
 *    onde vive a sessão de quem está logado;
 *  • **nosniff**: o navegador adivinhar que um upload é JavaScript e executá-lo;
 *  • **form-action**: um formulário nosso postar em servidor de terceiro.
 *
 * Sobre a franqueza do 'unsafe-inline' em script-src: as nossas páginas são
 * HTML embutido no servidor, com o JS dentro de <script> no próprio arquivo.
 * Enquanto for assim, o CSP não consegue distinguir o nosso script de um
 * injetado, e declarar o contrário seria só teatro. Ele ainda barra script de
 * ORIGEM externa, que é o vetor comum. Tirar o inline exige mover o JS para
 * arquivos servidos à parte — vale fazer, mas é mudança de estrutura, não de
 * cabeçalho.
 *
 * As páginas geradas por IA em `/s/` NÃO passam por aqui: elas definem o
 * próprio CSP, com `sandbox`, e sobrescrevem estes valores. Ver `site.routes`.
 */

/** Origens externas de que as nossas telas realmente dependem. */
const MP_SDK = 'https://sdk.mercadopago.com';
const MP_API = 'https://api.mercadopago.com';

const CSP = [
  "default-src 'self'",
  // O SDK do Mercado Pago é carregado pelo checkout de cartão.
  `script-src 'self' 'unsafe-inline' ${MP_SDK}`,
  "style-src 'self' 'unsafe-inline'",
  // QR do Pix chega como PNG em base64 na própria resposta.
  "img-src 'self' data:",
  `connect-src 'self' ${MP_SDK} ${MP_API}`,
  // O campo de cartão do MP roda em iframe dele.
  `frame-src ${MP_SDK} ${MP_API}`,
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');

  /*
   * HSTS só sob https de verdade.
   *
   * Mandá-lo em desenvolvimento faria o navegador do próprio time gravar
   * "este host é sempre https" para localhost — e depois recusar o servidor
   * local por um ano, com um erro que não explica nada.
   */
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  next();
}
