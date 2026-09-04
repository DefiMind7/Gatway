/**
 * Documentação da API, para a loja integrar sem precisar falar com ninguém.
 *
 * Página estática e sem segredo: é o que a loja abre antes de decidir se
 * integra. Mesma decisão das outras telas — HTML embutido, sem CDN, sem passo
 * de build.
 */
export const DOCS_PAGE_HTML = String.raw`<!doctype html>
<html lang="pt">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>API — Gateway de pagamentos</title>
<style>
  :root{--bg:#0f1216;--panel:#171b21;--panel2:#1e242c;--line:#2a323c;--tx:#e6eaef;--dim:#94a1b2;--ok:#3ddc97;--warn:#ffb84d;--acc:#5b9dff}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--tx);
       font:15px/1.65 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  main{max-width:820px;margin:0 auto;padding:32px 20px 80px}
  h1{font-size:26px;margin:0 0 6px}
  h2{font-size:15px;text-transform:uppercase;letter-spacing:.07em;color:var(--dim);
     margin:40px 0 12px;padding-top:20px;border-top:1px solid var(--line)}
  h3{font-size:16px;margin:26px 0 8px}
  p{margin:10px 0}
  p.lead{color:var(--dim);margin:0 0 8px}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;
       background:var(--panel2);border:1px solid var(--line);border-radius:4px;padding:1px 5px}
  pre{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px;
      overflow-x:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;
      line-height:1.6}
  pre .c{color:var(--dim)}
  table{width:100%;border-collapse:collapse;font-size:14px;margin:12px 0}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
  th{color:var(--dim);font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.05em}
  .verb{display:inline-block;background:var(--acc);color:#07101f;font-weight:700;font-size:11px;
        border-radius:4px;padding:2px 7px;margin-right:8px;vertical-align:middle}
  .verb.get{background:var(--ok)}
  .path{font-family:ui-monospace,Menlo,monospace;font-size:14px}
  .note{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--warn);
        border-radius:8px;padding:12px 14px;margin:16px 0;font-size:14px;color:var(--dim)}
  .note b{color:var(--tx)}
  a{color:var(--acc)}
  footer{color:var(--dim);font-size:12px;margin-top:48px;border-top:1px solid var(--line);padding-top:16px}
</style>
</head>
<body>
<main>
  <h1>API de pagamentos</h1>
  <p class="lead">
    Aceite pagamentos em reais e entregue SOL na carteira do seu cliente. Você cria a cobrança,
    manda o cliente para o checkout, e recebe um aviso quando o dinheiro entra.
  </p>

  <h2>Como funciona</h2>
  <pre><span class="c">1.</span> sua loja  ──POST /api/v1/charges──►  gateway
<span class="c">2.</span> gateway   ──devolve checkoutUrl───────►  sua loja
<span class="c">3.</span> cliente   ──paga Pix ou cartão────────►  checkout
<span class="c">4.</span> gateway   ──webhook charge.pago───────►  sua loja  <span class="c">(libere o pedido)</span>
<span class="c">5.</span> gateway   ──webhook charge.entregue──►  sua loja  <span class="c">(SOL na carteira)</span></pre>

  <h2>Autenticação</h2>
  <p>Toda chamada leva a sua chave no cabeçalho. Ela é secreta: use no servidor, nunca no navegador.</p>
  <pre>Authorization: Bearer sk_live_…</pre>
  <div class="note">
    <b>A chave aparece uma única vez</b>, quando a loja é criada — guardamos apenas o hash dela.
    Se perder, peça uma nova; a anterior deixa de valer no mesmo instante.
  </div>

  <h2>Criar cobrança</h2>
  <p><span class="verb">POST</span><span class="path">/api/v1/charges</span></p>

  <table>
    <tr><th>Campo</th><th>Obrigatório</th><th>Descrição</th></tr>
    <tr><td><code>amount</code></td><td>sim</td><td>Valor em reais. Respeita os limites do gateway (ver <code>/api/v1/config</code>).</td></tr>
    <tr><td><code>method</code></td><td>não</td><td><code>PIXQR</code> (padrão) ou <code>CARD</code>.</td></tr>
    <tr><td><code>externalId</code></td><td>não</td><td>Id do pedido no seu sistema. Volta em todo webhook.</td></tr>
    <tr><td><code>destinationWallet</code></td><td>não</td><td>Endereço Solana que recebe o SOL. Sem ele, o cliente cria conta no checkout e ganha uma carteira.</td></tr>
    <tr><td><code>callbackUrl</code></td><td>não</td><td>Onde receber os webhooks. Precisa ser https público.</td></tr>
    <tr><td><code>returnUrl</code></td><td>não</td><td>Para onde devolver o cliente depois de pagar.</td></tr>
  </table>

  <pre>curl -X POST https://SEU-DOMINIO/api/v1/charges \
  -H "Authorization: Bearer sk_live_…" \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 25.00,
    "method": "PIXQR",
    "externalId": "pedido-1234",
    "callbackUrl": "https://sualoja.com/webhooks/gateway"
  }'</pre>

  <p>Resposta <code>201</code>:</p>
  <pre>{
  "id": "GW-A7NSDZ",                 <span class="c">// use este id nas consultas</span>
  "status": "pendente",
  "amount": "25",
  "currency": "BRL",
  "externalId": "pedido-1234",
  "checkoutUrl": "https://SEU-DOMINIO/pay?ref=GW-A7NSDZ",
  "destinationWallet": "Bp8fscF9t7FJSuNn9NzZJsxdvzH2sCKhKNFFeM5KXrEM",
  "solDelivered": null,
  "expiresAt": "2026-09-04T18:20:00.000Z"
}</pre>
  <p>Mande o cliente para <code>checkoutUrl</code>.</p>

  <h2>Consultar cobrança</h2>
  <p><span class="verb get">GET</span><span class="path">/api/v1/charges/GW-A7NSDZ</span></p>
  <p>Use quando perder um webhook. Devolve o mesmo objeto, com o estado atual.</p>

  <table>
    <tr><th>status</th><th>Significa</th></tr>
    <tr><td><code>pendente</code></td><td>criada, ainda não paga</td></tr>
    <tr><td><code>pago</code></td><td>dinheiro recebido — <b>libere o pedido aqui</b></td></tr>
    <tr><td><code>entregue</code></td><td>SOL creditado na carteira do cliente</td></tr>
    <tr><td><code>expirado</code></td><td>o prazo passou sem pagamento</td></tr>
    <tr><td><code>falhou</code></td><td>pago, mas a entrega falhou — o operador é avisado</td></tr>
  </table>

  <div class="note">
    <b>Libere o pedido em <code>pago</code>, não em <code>entregue</code>.</b>
    O dinheiro já está com o gateway em <code>pago</code>; a entrega do SOL é uma etapa seguinte,
    que pode levar minutos.
  </div>

  <h2>Webhooks</h2>
  <p>Enviamos <code>POST</code> para o seu <code>callbackUrl</code> nos eventos
     <code>charge.pago</code>, <code>charge.entregue</code> e <code>charge.falhou</code>.</p>

  <pre>{
  "event": "charge.pago",
  "charge": { <span class="c">…o mesmo objeto da consulta…</span> }
}</pre>

  <h3>Verificando a assinatura</h3>
  <p>Todo webhook leva o cabeçalho <code>X-Gateway-Signature</code>:</p>
  <pre>X-Gateway-Signature: t=1788470000,v1=9f8e7d…</pre>
  <p>Calcule o HMAC-SHA256 de <code>"{t}.{corpo cru}"</code> com o seu webhook secret e compare:</p>
  <pre><span class="c">// Node.js</span>
const [t, v1] = header.split(',').map(p => p.split('=')[1]);
const esperado = crypto.createHmac('sha256', WEBHOOK_SECRET)
                       .update(t + '.' + corpoCru)
                       .digest('hex');
if (!crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(esperado))) return res.status(401).end();</pre>

  <div class="note">
    Use o <b>corpo cru</b> da requisição, antes de qualquer parse. Reserializar o JSON muda
    espaços e ordem de chaves, e a assinatura deixa de bater.
  </div>

  <p>Responda <code>2xx</code>. Qualquer outra coisa vira nova tentativa — repetimos até 8 vezes,
     espaçadas. O mesmo evento pode chegar duas vezes: trate pelo <code>id</code> da cobrança,
     que é estável.</p>

  <h2>Limites e trilhos</h2>
  <p><span class="verb get">GET</span><span class="path">/api/v1/config</span></p>
  <p>Devolve os meios aceitos e a faixa de valores. Consulte na inicialização em vez de fixar no código.</p>

  <h2>Erros</h2>
  <table>
    <tr><th>HTTP</th><th>Quando</th></tr>
    <tr><td><code>401</code></td><td>chave ausente, inválida ou loja desativada</td></tr>
    <tr><td><code>400</code></td><td>valor fora da faixa, moeda não aceita, URL não-https</td></tr>
    <tr><td><code>404</code></td><td>cobrança inexistente, ou de outra loja</td></tr>
  </table>
  <pre>{ "error": "AMOUNT_OUT_OF_RANGE", "message": "amount fora da faixa aceita (1..25)" }</pre>

  <footer>
    Ambiente de teste. Peça as suas credenciais ao operador do gateway.
  </footer>
</main>
</body>
</html>`;
