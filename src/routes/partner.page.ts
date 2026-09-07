/**
 * Página pública de candidatura — a porta de entrada comercial.
 *
 * É o que uma loja abre antes de existir qualquer relação: ela conta quem é, o
 * que vende e quanto espera transacionar, e o operador decide. Nenhuma chave é
 * emitida aqui; sair daqui com credencial transformaria um formulário aberto na
 * internet em emissor de acesso a cobrança.
 */
export const PARTNER_PAGE_HTML = String.raw`<!doctype html>
<html lang="pt">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0f1216">
<title>Integrar o gateway na sua loja</title>
<style>
  :root{--bg:#0f1216;--panel:#171b21;--panel2:#1e242c;--line:#2a323c;--tx:#e6eaef;--dim:#94a1b2;--ok:#3ddc97;--err:#ff6b6b;--acc:#5b9dff}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--tx);
       font:15px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  main{max-width:620px;margin:0 auto;
       padding:calc(28px + env(safe-area-inset-top)) 18px calc(60px + env(safe-area-inset-bottom))}
  h1{font-size:24px;margin:0 0 6px}
  p.lead{color:var(--dim);margin:0 0 24px}
  section{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:20px}
  h2{font-size:12px;text-transform:uppercase;letter-spacing:.07em;color:var(--dim);margin:0 0 16px}
  label{display:block;font-size:12px;color:var(--dim);margin:14px 0 5px}
  label .req{color:var(--acc)}
  input,select,textarea,button{font:inherit;color:var(--tx);background:var(--panel2);
    border:1px solid var(--line);border-radius:8px;padding:11px 12px;width:100%;min-height:44px}
  textarea{min-height:90px;resize:vertical}
  input:focus,select:focus,textarea:focus{outline:1px solid var(--acc)}
  button{cursor:pointer;background:var(--acc);border-color:var(--acc);color:#07101f;
         font-weight:650;margin-top:22px}
  button:disabled{opacity:.5;cursor:not-allowed}
  .row{display:flex;gap:12px}
  .row>div{flex:1}
  .hint{font-size:11px;color:var(--dim);margin:5px 0 0}
  .banner{padding:12px 14px;border-radius:8px;font-size:14px;border:1px solid;margin-bottom:18px}
  .banner.e{background:#3a1a1a;border-color:#6b2a2a;color:#ffc4c4}
  .banner.o{background:#12312a;border-color:#1f5f4f;color:#b6f0dc}
  .hide{display:none!important}
  .passos{display:grid;gap:10px;margin:0 0 24px;padding:0;list-style:none}
  .passos li{display:flex;gap:12px;align-items:flex-start;font-size:14px;color:var(--dim)}
  .passos b{display:grid;place-items:center;flex:0 0 24px;height:24px;border-radius:50%;
            background:var(--panel2);border:1px solid var(--line);color:var(--tx);font-size:12px}
  footer{color:var(--dim);font-size:12px;text-align:center;margin-top:26px;line-height:1.7}
  a{color:var(--acc)}
</style>
</head>
<body>
<main>
  <h1>Aceite pagamentos e entregue cripto</h1>
  <p class="lead">
    Seus clientes pagam em reais por Pix ou cartão, e recebem SOL na carteira deles.
    Você integra com quatro chamadas de API.
  </p>

  <ol class="passos">
    <li><b>1</b><span>Você conta quem é, no formulário abaixo.</span></li>
    <li><b>2</b><span>Analisamos e respondemos por e-mail.</span></li>
    <li><b>3</b><span>Aprovado, você recebe a chave de API e o segredo de webhook.</span></li>
    <li><b>4</b><span>Integra seguindo a <a href="/docs" target="_blank" rel="noopener">documentação</a>.</span></li>
  </ol>

  <div id="alert" class="banner e hide"></div>

  <section id="form">
    <h2>Sobre a sua empresa</h2>

    <label for="companyName">Nome da empresa <span class="req">*</span></label>
    <input id="companyName" placeholder="Como a sua loja é conhecida" maxlength="120">

    <div class="row">
      <div>
        <label for="legalName">Razão social</label>
        <input id="legalName" placeholder="Nome registrado" maxlength="160">
      </div>
      <div>
        <label for="taxId">CNPJ</label>
        <input id="taxId" placeholder="00.000.000/0001-00" maxlength="20">
      </div>
    </div>

    <div class="row">
      <div>
        <label for="email">E-mail de contato <span class="req">*</span></label>
        <input id="email" type="email" placeholder="voce@empresa.com" maxlength="254">
      </div>
      <div>
        <label for="phone">Telefone</label>
        <input id="phone" placeholder="(11) 90000-0000" maxlength="30">
      </div>
    </div>

    <label for="website">Site</label>
    <input id="website" placeholder="https://sualoja.com" maxlength="200">
    <p class="hint">Precisa começar com https.</p>

    <h2 style="margin-top:26px">Sobre a integração</h2>

    <label for="expectedVolume">Volume mensal esperado</label>
    <select id="expectedVolume">
      <option value="">prefiro não informar</option>
      <option>até R$ 5 mil/mês</option>
      <option>R$ 5 mil a R$ 50 mil/mês</option>
      <option>R$ 50 mil a R$ 500 mil/mês</option>
      <option>acima de R$ 500 mil/mês</option>
    </select>

    <label for="callbackUrl">URL para receber os webhooks</label>
    <input id="callbackUrl" placeholder="https://sualoja.com/webhooks/gateway" maxlength="300">
    <p class="hint">Onde avisamos que um pagamento entrou. Dá para definir depois.</p>

    <label for="description">O que você vende, e como pretende usar</label>
    <textarea id="description" placeholder="Conte em duas linhas — ajuda a análise a ser rápida." maxlength="2000"></textarea>

    <button id="send">Pedir análise</button>
  </section>

  <section id="done" class="hide" style="text-align:center">
    <h2>Pedido enviado</h2>
    <p style="margin:0 0 6px">Recebemos o seu pedido e vamos analisar.</p>
    <p class="hint" id="doneEmail" style="font-size:13px"></p>
  </section>

  <footer>
    Dúvidas sobre a integração? A <a href="/docs">documentação da API</a> é pública.
  </footer>
</main>

<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };

  function alerta(msg, tipo) {
    var el = $('alert');
    if (!msg) { el.className = 'banner e hide'; return; }
    el.className = 'banner ' + (tipo || 'e');
    el.textContent = msg;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  $('send').addEventListener('click', function () {
    alerta('');
    var corpo = {
      companyName: $('companyName').value.trim(),
      legalName: $('legalName').value.trim(),
      taxId: $('taxId').value.trim(),
      email: $('email').value.trim(),
      phone: $('phone').value.trim(),
      website: $('website').value.trim(),
      callbackUrl: $('callbackUrl').value.trim(),
      expectedVolume: $('expectedVolume').value,
      description: $('description').value.trim()
    };

    if (!corpo.companyName) { alerta('Informe o nome da empresa.'); return; }
    if (!corpo.email) { alerta('Informe um e-mail de contato.'); return; }

    // Campos vazios saem do corpo: o servidor distingue "não informado" de
    // "informado em branco", e a validação de URL só roda no que veio.
    Object.keys(corpo).forEach(function (k) { if (!corpo[k]) delete corpo[k]; });

    $('send').disabled = true;
    $('send').textContent = 'enviando…';

    fetch('/api/v1/applications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo)
    }).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) throw new Error(body && body.message ? body.message : 'erro ' + res.status);
        return body;
      });
    }).then(function (body) {
      $('form').classList.add('hide');
      $('done').classList.remove('hide');
      $('doneEmail').textContent = 'A resposta vai para ' + body.email + '.';
    }).catch(function (err) {
      alerta(err.message);
      $('send').disabled = false;
      $('send').textContent = 'Pedir análise';
    });
  });
})();
</script>
</body>
</html>`;
