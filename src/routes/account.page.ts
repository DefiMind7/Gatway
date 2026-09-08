/**
 * `/conta` — entrar ou criar conta. O meio do funil.
 *
 * É UMA conta para a pessoa, não uma por operação. A mesma identidade compra
 * cripto e, se quiser, abre uma loja: obrigar quem faz as duas coisas a
 * guardar duas senhas para a mesma relação é o tipo de coisa que ninguém
 * consegue explicar, e a segunda senha é sempre a que se perde.
 *
 * O cadastro cria a carteira junto — ver `register` em customer.service. É por
 * isso que ele fica aqui e não depois: sem carteira não há para onde entregar
 * o que a pessoa comprar.
 *
 * Cuidado ao editar: o corpo vive dentro de String.raw. Crase aqui encerra o
 * literal — o JS desta página concatena com +, sem template literal.
 */
export const ACCOUNT_PAGE_HTML = String.raw`<!doctype html>
<html lang="pt">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0f1216">
<title>Entrar</title>
<style>
  :root{--bg:#0f1216;--panel:#171b21;--panel2:#1e242c;--line:#2a323c;--tx:#e6eaef;--dim:#94a1b2;--ok:#3ddc97;--err:#ff6b6b;--acc:#5b9dff}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--tx);
       font:15px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  main{max-width:440px;margin:0 auto;
       padding:calc(48px + env(safe-area-inset-top)) 20px calc(60px + env(safe-area-inset-bottom))}
  h1{font-size:22px;margin:0 0 6px}
  p.lead{color:var(--dim);font-size:14px;margin:0 0 24px}
  section{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:20px}
  label{display:block;font-size:12px;color:var(--dim);margin:14px 0 5px}
  input,button{font:inherit;color:var(--tx);background:var(--panel2);
    border:1px solid var(--line);border-radius:8px;padding:12px;width:100%;min-height:46px}
  input:focus{outline:1px solid var(--acc)}
  button{cursor:pointer;background:var(--acc);border-color:var(--acc);color:#07101f;
         font-weight:650;margin-top:20px}
  button:disabled{opacity:.5;cursor:not-allowed}
  .abas{display:flex;gap:6px;margin-bottom:16px}
  .abas button{margin:0;flex:1;width:auto;background:var(--panel);border-color:var(--line);
               color:var(--dim);font-weight:500;min-height:42px}
  .abas button.on{background:var(--acc);border-color:var(--acc);color:#07101f;font-weight:650}
  .banner{padding:11px 13px;border-radius:8px;font-size:13px;border:1px solid;margin-bottom:14px}
  .banner.e{background:#3a1a1a;border-color:#6b2a2a;color:#ffc4c4}
  .banner.o{background:#12312a;border-color:#1f5f4f;color:#b6f0dc}
  .hide{display:none!important}
  .nota{color:var(--dim);font-size:12px;margin:14px 0 0}
  footer{color:var(--dim);font-size:12px;text-align:center;margin-top:24px;line-height:1.9}
  a{color:var(--acc)}
</style>
</head>
<body>
<main>
  <h1>Sua conta</h1>
  <p class="lead">Uma só, para comprar e para vender.</p>

  <div id="alert" class="banner e hide"></div>

  <div class="abas">
    <button class="on" data-aba="entrar">Entrar</button>
    <button data-aba="criar">Criar conta</button>
  </div>

  <section data-p="entrar">
    <label for="email">E-mail</label>
    <input id="email" type="email" autocomplete="username" placeholder="voce@exemplo.com">
    <label for="senha">Senha</label>
    <input id="senha" type="password" autocomplete="current-password">
    <button id="entrar">Entrar</button>
  </section>

  <section data-p="criar" class="hide">
    <label for="cEmail">E-mail</label>
    <input id="cEmail" type="email" autocomplete="username" placeholder="voce@exemplo.com">
    <label for="cSenha">Senha</label>
    <input id="cSenha" type="password" autocomplete="new-password" placeholder="mínimo de 8 caracteres">
    <label for="cSenha2">Repita a senha</label>
    <input id="cSenha2" type="password" autocomplete="new-password">
    <button id="criar">Criar conta</button>
    <p class="nota">
      Criamos uma carteira Solana para você no mesmo instante. A chave privada
      dela é sua e você pode exportá-la quando quiser.
    </p>
  </section>

  <footer>
    <a href="/">Voltar ao início</a>
  </footer>
</main>

<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var CHAVE = 'gw:session';

  function alerta(msg, tipo) {
    var el = $('alert');
    if (!msg) { el.className = 'banner e hide'; return; }
    el.className = 'banner ' + (tipo || 'e');
    el.textContent = msg;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function abrir(nome) {
    alerta('');
    var b = document.querySelectorAll('.abas button');
    for (var i = 0; i < b.length; i++) {
      b[i].className = b[i].getAttribute('data-aba') === nome ? 'on' : '';
    }
    var s = document.querySelectorAll('section');
    for (var j = 0; j < s.length; j++) {
      s[j].className = s[j].getAttribute('data-p') === nome ? '' : 'hide';
    }
  }

  document.querySelector('.abas').addEventListener('click', function (e) {
    var a = e.target.getAttribute('data-aba');
    if (a) abrir(a);
  });

  // Quem clicou em "Criar a minha conta" na home já chega na aba certa.
  if (location.search.indexOf('novo=1') !== -1) abrir('criar');

  function api(caminho, corpo) {
    return fetch('/pay' + caminho, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo)
    }).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) throw new Error(body && body.message ? body.message : 'erro ' + res.status);
        return body;
      });
    });
  }

  function guardarEIr(r) {
    try { localStorage.setItem(CHAVE, r.token); } catch (e) { /* modo privado */ }
    // Para onde a pessoa ia antes de ser mandada para cá, ou o hub.
    var destino = new URLSearchParams(location.search).get('destino');
    location.href = destino && destino.charAt(0) === '/' ? destino : '/inicio';
  }

  $('entrar').addEventListener('click', function () {
    alerta('');
    $('entrar').disabled = true;
    api('/api/auth/login', { email: $('email').value.trim(), password: $('senha').value })
      .then(guardarEIr)
      .catch(function (err) { alerta(err.message); $('entrar').disabled = false; });
  });

  $('senha').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') $('entrar').click();
  });

  $('criar').addEventListener('click', function () {
    alerta('');
    if ($('cSenha').value !== $('cSenha2').value) {
      alerta('As duas senhas não são iguais.'); return;
    }
    $('criar').disabled = true;
    api('/api/auth/register', { email: $('cEmail').value.trim(), password: $('cSenha').value })
      .then(guardarEIr)
      .catch(function (err) { alerta(err.message); $('criar').disabled = false; });
  });

  /**
   * Já logado não tem o que fazer aqui.
   *
   * E vai para o destino pedido na URL, se veio com um: quem clicou em comprar e caiu aqui
   * por um token vencido espera voltar para a compra, não para o menu.
   */
  function jaLogado() {
    var d = new URLSearchParams(location.search).get('destino');
    location.href = d && d.charAt(0) === '/' ? d : '/inicio';
  }

  var atual = null;
  try { atual = localStorage.getItem(CHAVE); } catch (e) { /* modo privado */ }
  if (atual) {
    fetch('/pay/api/account', { headers: { 'x-session': atual } })
      .then(function (r) { if (r.ok) jaLogado(); })
      .catch(function () { /* sessão morta: fica na tela de login */ });
  }
})();
</script>
</body>
</html>`;
