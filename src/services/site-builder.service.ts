import axios from 'axios';
import type { Merchant, MerchantSite } from '@prisma/client';
import { prisma } from '../database/client';
import { GatewayError } from '../types';
import { logger } from '../utils/logger';
import { open, seal } from '../utils/secret-box';

/**
 * Construtor de lojas: a pessoa descreve o que quer e o Claude escreve o site.
 *
 * Três decisões que definem isto:
 *
 *  • **a chave da API é da loja, não nossa.** Quem gera paga, e a conta chega
 *    para quem apertou o botão. Faturar geração por fora significaria estimar
 *    consumo de token de terceiros e cobrar por ele — negócio diferente do
 *    nosso, com risco de prejuízo em todo prompt longo. Guardamos a chave
 *    cifrada e nunca a devolvemos em claro;
 *
 *  • **o HTML gerado é conteúdo hostil por definição.** Não porque a loja
 *    queira nos atacar, mas porque quem escreve é um modelo respondendo a um
 *    texto livre que qualquer um pode influenciar. Ele é servido numa origem
 *    opaca (ver o CSP em `site.routes`), então não alcança a sessão de
 *    ninguém;
 *
 *  • **a chave de API do gateway nunca desce para a página.** O botão de
 *    comprar é um form que posta no NOSSO servidor, que cria a cobrança em
 *    nome da loja. Um site estático que carregasse a chave a entregaria a
 *    todo visitante que abrisse o código-fonte.
 */

const log = logger.child({ scope: 'site.builder' });

const API = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const MODELO = 'claude-sonnet-5';

/** Teto do HTML guardado. Acima disto é quase sempre o modelo se perdendo. */
const MAX_HTML = 400_000;
const MAX_PROMPT = 4_000;

// ─────────────────────────── Chave da loja ───────────────────────────

/**
 * Guarda a chave da Anthropic da loja.
 *
 * Só o formato é validado aqui; se ela funciona, descobre-se na primeira
 * geração — e o erro que a Anthropic devolve é mais informativo do que
 * qualquer chamada de teste que eu fizesse por conta própria.
 */
export async function setAiKey(merchantId: string, chave: string): Promise<string> {
  const limpa = String(chave ?? '').trim();

  if (!limpa.startsWith('sk-ant-')) {
    throw new GatewayError(
      'a chave da Anthropic começa com sk-ant- — copie de console.anthropic.com',
      'INVALID_AI_KEY',
      false,
    );
  }
  if (limpa.length < 40 || limpa.length > 300) {
    throw new GatewayError('essa chave não parece completa', 'INVALID_AI_KEY', false);
  }

  const cofre = seal(limpa);
  const hint = '…' + limpa.slice(-6);

  await prisma.merchant.update({
    where: { id: merchantId },
    data: {
      aiKeyEnc: cofre.enc,
      aiKeyIv: cofre.iv,
      aiKeyTag: cofre.tag,
      aiKeyHint: hint,
      aiKeySetAt: new Date(),
    },
  });

  log.warn({ merchantId }, 'loja guardou a chave da Anthropic');
  return hint;
}

export async function clearAiKey(merchantId: string): Promise<void> {
  await prisma.merchant.update({
    where: { id: merchantId },
    data: { aiKeyEnc: null, aiKeyIv: null, aiKeyTag: null, aiKeyHint: null, aiKeySetAt: null },
  });
  log.warn({ merchantId }, 'chave da Anthropic removida');
}

function lerChave(loja: Merchant): string {
  if (!loja.aiKeyEnc || !loja.aiKeyIv || !loja.aiKeyTag) {
    throw new GatewayError(
      'configure a sua chave da Anthropic antes de gerar o site',
      'NO_AI_KEY',
      false,
    );
  }
  return open({ enc: loja.aiKeyEnc, iv: loja.aiKeyIv, tag: loja.aiKeyTag });
}

// ─────────────────────────── O site ───────────────────────────

/** Slug a partir do nome da loja, sem acento e sem colisão. */
async function gerarSlug(nome: string): Promise<string> {
  const base =
    nome
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'loja';

  for (let i = 0; i < 50; i += 1) {
    const tentativa = i === 0 ? base : `${base}-${i + 1}`;
    const existe = await prisma.merchantSite.findUnique({ where: { slug: tentativa } });
    if (!existe) return tentativa;
  }
  return `${base}-${Date.now().toString(36)}`;
}

export async function getSite(merchantId: string): Promise<MerchantSite | null> {
  return prisma.merchantSite.findUnique({ where: { merchantId } });
}

/**
 * O contrato que o modelo precisa cumprir.
 *
 * O ponto que não é negociável é o formulário de compra: sem ele o site é uma
 * vitrine bonita que não vende, e vender é a razão de tudo isto existir. Por
 * isso o formato do form vem escrito de forma literal, e não como sugestão.
 */
function instrucoes(loja: Merchant, slug: string, base: string): string {
  return [
    'Você escreve a loja online de um comerciante brasileiro, como UM ÚNICO arquivo HTML.',
    '',
    `Nome da loja: ${loja.name}`,
    `Endereço público: ${base}/s/${slug}`,
    '',
    'REGRAS DE SAÍDA',
    '- Responda APENAS com o HTML, começando em <!doctype html>. Sem crases, sem explicação.',
    '- Tudo embutido: CSS em <style> e JS em <script> no próprio arquivo.',
    '- Não use imagens externas nem fontes externas; a página é servida isolada e',
    '  requisições para fora são bloqueadas. Use CSS, emoji e SVG inline.',
    '- Escreva em português do Brasil.',
    '',
    'CHECKOUT — copie esta estrutura em cada produto, sem alterar action, method nem os names:',
    '',
    `  <form method="POST" action="/s/${slug}/checkout">`,
    '    <input type="hidden" name="item" value="NOME DO PRODUTO">',
    '    <input type="hidden" name="amount" value="49.90">',
    '    <button type="submit">Comprar</button>',
    '  </form>',
    '',
    '- `amount` é o preço em reais, com ponto decimal.',
    '- O botão precisa ser um <button type="submit"> de verdade, dentro do form.',
    '  Não intercepte o envio com JavaScript: o pagamento acontece fora da página.',
    '- Não escreva chave de API nenhuma no arquivo. O pagamento é resolvido pelo servidor.',
    '',
    'QUALIDADE',
    '- Layout responsivo, que funcione bem no telefone.',
    '- Cabeçalho com o nome da loja, uma vitrine de produtos com preço, e rodapé.',
    '- Visual profissional e sóbrio. Sem texto de exemplo tipo "lorem ipsum".',
    '- Se o pedido não disser quais produtos, invente três coerentes com o ramo,',
    '  com preços plausíveis em reais.',
  ].join('\n');
}

/** Tira cercas de markdown e qualquer coisa antes do doctype. */
function limparHtml(bruto: string): string {
  let html = bruto.trim();

  const cerca = html.match(/^```(?:html)?\s*([\s\S]*?)\s*```$/i);
  if (cerca?.[1]) html = cerca[1].trim();

  const inicio = html.search(/<!doctype html/i);
  if (inicio > 0) html = html.slice(inicio);

  return html;
}

export interface GenerateResult {
  site: MerchantSite;
  /** Quanto o modelo consumiu — a conta é da loja, então ela vê. */
  usage: { inputTokens: number; outputTokens: number };
}

/**
 * Gera (ou regenera) o site a partir do pedido em texto.
 *
 * O resultado vai para o rascunho, nunca direto para o ar: ver o comentário do
 * modelo `MerchantSite`.
 */
export async function generateSite(
  loja: Merchant,
  pedido: string,
  baseUrl: string,
): Promise<GenerateResult> {
  const prompt = String(pedido ?? '').trim();
  if (prompt.length < 10) {
    throw new GatewayError(
      'descreva a sua loja com um pouco mais de detalhe — o que você vende, para quem',
      'PROMPT_TOO_SHORT',
      false,
    );
  }
  if (prompt.length > MAX_PROMPT) {
    throw new GatewayError('pedido longo demais', 'PROMPT_TOO_LONG', false);
  }

  const chave = lerChave(loja);
  const existente = await getSite(loja.id);
  const slug = existente?.slug ?? (await gerarSlug(loja.name));

  // Regeneração parte do que já existe: pedir "deixe o cabeçalho verde" sem
  // mostrar o cabeçalho atual faria o modelo reescrever a loja inteira.
  const mensagem = existente?.draftHtml
    ? [
        'Esta é a loja atual:',
        '',
        existente.draftHtml.slice(0, 120_000),
        '',
        'Aplique a este HTML a seguinte mudança, mantendo o resto como está:',
        '',
        prompt,
        '',
        'Responda com o arquivo HTML completo e atualizado.',
      ].join('\n')
    : prompt;

  let resposta;
  try {
    resposta = await axios.post(
      API,
      {
        model: MODELO,
        max_tokens: 16_000,
        system: instrucoes(loja, slug, baseUrl),
        messages: [{ role: 'user', content: mensagem }],
      },
      {
        timeout: 240_000,
        headers: {
          'x-api-key': chave,
          'anthropic-version': API_VERSION,
          'content-type': 'application/json',
        },
      },
    );
  } catch (err) {
    // O erro da Anthropic é mais útil do que qualquer paráfrase minha: ele diz
    // se a chave é inválida, se acabou o crédito, ou se bateu limite de uso.
    const detalhe =
      axios.isAxiosError(err) && err.response?.data
        ? ((err.response.data as { error?: { message?: string } }).error?.message ??
          JSON.stringify(err.response.data).slice(0, 200))
        : err instanceof Error
          ? err.message
          : 'falha desconhecida';

    log.warn({ merchantId: loja.id, detalhe }, 'geração do site falhou');
    throw new GatewayError(`a Anthropic recusou a chamada: ${detalhe}`, 'AI_CALL_FAILED', false);
  }

  const corpo = resposta.data as {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  const texto = (corpo.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');

  const html = limparHtml(texto);

  if (!/^<!doctype html/i.test(html)) {
    throw new GatewayError(
      'o modelo não devolveu um HTML completo — tente descrever a loja de novo',
      'AI_BAD_OUTPUT',
      false,
    );
  }
  if (html.length > MAX_HTML) {
    throw new GatewayError('o site gerado ficou grande demais', 'AI_BAD_OUTPUT', false);
  }

  const site = await prisma.merchantSite.upsert({
    where: { merchantId: loja.id },
    create: {
      merchantId: loja.id,
      slug,
      title: loja.name,
      prompt,
      draftHtml: html,
      generations: 1,
    },
    update: { prompt, draftHtml: html, generations: { increment: 1 } },
  });

  log.warn(
    { merchantId: loja.id, slug, bytes: html.length },
    'site gerado — aguardando publicação',
  );

  return {
    site,
    usage: {
      inputTokens: corpo.usage?.input_tokens ?? 0,
      outputTokens: corpo.usage?.output_tokens ?? 0,
    },
  };
}

/** Põe o rascunho no ar. */
export async function publishSite(merchantId: string): Promise<MerchantSite> {
  const site = await getSite(merchantId);
  if (!site?.draftHtml) {
    throw new GatewayError('gere o site antes de publicar', 'NO_DRAFT', false);
  }

  return prisma.merchantSite.update({
    where: { merchantId },
    data: { publishedHtml: site.draftHtml, published: true, publishedAt: new Date() },
  });
}

/** Tira do ar sem apagar nada: o rascunho e o publicado continuam guardados. */
export async function unpublishSite(merchantId: string): Promise<void> {
  await prisma.merchantSite.update({ where: { merchantId }, data: { published: false } });
  log.warn({ merchantId }, 'site despublicado');
}

/** O site que o público vê. Null quando não há nada no ar. */
export async function findPublished(
  slug: string,
): Promise<{ site: MerchantSite; merchant: Merchant } | null> {
  const site = await prisma.merchantSite.findUnique({
    where: { slug },
    include: { merchant: true },
  });

  if (!site || !site.published || !site.publishedHtml) return null;
  if (!site.merchant.active) return null;

  return { site, merchant: site.merchant };
}
