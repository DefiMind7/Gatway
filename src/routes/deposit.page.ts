/**
 * Checkout público — página única, embutida como string.
 *
 * Mesma decisão do painel do admin: `tsc` não copia assets para `dist/`, então
 * um HTML inline é mais robusto do que um passo extra de build. Sem CDN, sem
 * framework, sem fonte externa — a página tem de abrir num celular com rede
 * ruim e não deixar o cliente olhando para um branco.
 *
 * O formulário de cartão é o **Brick do Mercado Pago**: os campos de número,
 * validade e CVV são iframes servidos pelo MP dentro desta página. O cliente
 * não sai do site, o visual é nosso — e o dado do cartão nunca passa pelo
 * nosso servidor, que é o que mantém a operação fora do escopo PCI-DSS de
 * quem trafega PAN. O que sobe daqui para o backend é um token de uso único.
 *
 * A página não conhece segredo nenhum: fala só com `/pay/api/*`, que é
 * público de propósito. A `publicKey` do MP é pública por definição. O que protege o dinheiro está no servidor (faixa de
 * valores, rate limit por IP, câmbio do operador, teto por ordem).
 */
export const DEPOSIT_PAGE_HTML = String.raw`<!doctype html>
<html lang="pt">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#0f1216">
<link rel="manifest" href="/pwa/app.webmanifest">
<link rel="apple-touch-icon" href="/pwa/icon-192.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Depositar">
<meta name="mobile-web-app-capable" content="yes">
<title>Depositar — Gateway</title>
<style>
  :root{--bg:#0f1216;--panel:#171b21;--panel2:#1e242c;--line:#2a323c;--tx:#e6eaef;--dim:#94a1b2;--ok:#3ddc97;--warn:#ffb84d;--err:#ff6b6b;--acc:#5b9dff}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  main{max-width:560px;margin:0 auto;
       padding:calc(20px + env(safe-area-inset-top)) 16px calc(56px + env(safe-area-inset-bottom))}
  /* Alvo de toque confortável: 44px é o mínimo recomendado nos dois sistemas. */
  button,input,select{min-height:44px}
  button.mini{min-height:32px}
  h1{font-size:19px;margin:8px 0 4px}
  p.sub{color:var(--dim);font-size:13px;margin:0 0 20px}
  section{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px;margin-bottom:14px}
  h2{font-size:12px;text-transform:uppercase;letter-spacing:.07em;color:var(--dim);margin:0 0 14px}
  label{display:block;font-size:12px;color:var(--dim);margin:12px 0 5px}
  input,select,button{font:inherit;color:var(--tx);background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:11px 12px;width:100%}
  input:focus,select:focus{outline:1px solid var(--acc)}
  button{cursor:pointer;background:var(--acc);border-color:var(--acc);color:#07101f;font-weight:600;margin-top:18px}
  button.ghost{background:var(--panel2);border-color:var(--line);color:var(--tx);font-weight:500;margin-top:8px}
  button.mini{width:auto;padding:6px 10px;font-size:12px;margin:0}
  button:disabled{opacity:.5;cursor:not-allowed}
  .row{display:flex;gap:10px}
  .row>*{flex:1}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;word-break:break-all}
  .dim{color:var(--dim)}.ok{color:var(--ok)}.warn{color:var(--warn)}.err{color:var(--err)}
  .box{background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:12px;margin-top:10px}
  .box .k{font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em}
  .box .v{margin-top:3px}
  .pay{font-size:26px;font-weight:650;letter-spacing:-.01em}
  .banner{padding:11px 13px;border-radius:8px;font-size:13px;border:1px solid;margin-bottom:14px}
  .banner.e{background:#3a1a1a;border-color:#6b2a2a;color:#ffc4c4}
  .banner.w{background:#3a2c12;border-color:#6b4f1c;color:#ffd899}
  .banner.o{background:#12312a;border-color:#1f5f4f;color:#b6f0dc}
  ul{margin:10px 0 0;padding-left:18px;font-size:13px;color:var(--dim)}
  li{margin:5px 0}
  .steps{display:flex;gap:6px;margin-bottom:16px}
  .steps div{flex:1;height:3px;border-radius:2px;background:var(--line)}
  .steps div.on{background:var(--acc)}
  .hide{display:none!important}
  a{color:var(--acc)}
  .copy{display:flex;gap:8px;align-items:center;margin-top:6px}
  a.cta{display:block;text-align:center;background:var(--acc);color:#07101f;font-weight:650;
        border-radius:8px;padding:13px 12px;margin-top:16px;text-decoration:none}
  .split{display:flex;gap:10px;margin-top:10px}
  .split>div{flex:1;background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:10px}
  .split b{display:block;font-size:17px;font-weight:600;margin-top:2px}
  #cardBrick{margin-top:16px;min-height:40px}
  #pixBox{text-align:center}
  #pixQr{width:210px;height:210px;background:#fff;border-radius:10px;padding:8px;margin:4px auto 10px;display:block}
  #pixCode{font-size:11px;word-break:break-all;background:var(--panel2);border:1px solid var(--line);
           border-radius:8px;padding:9px;margin-top:6px;max-height:80px;overflow:auto;text-align:left}
  .loading{color:var(--dim);font-size:13px;text-align:center;padding:14px}
  .check{display:flex;gap:9px;align-items:flex-start;margin-top:14px}
  .check input{width:auto;margin-top:2px}
  .check span{font-size:13px;color:var(--tx)}
  .danger{background:#3a1a1a;border-color:#6b2a2a}
  .secret{word-break:break-all;font-size:12px;line-height:1.5}
  .tabs{display:flex;gap:8px;margin-bottom:4px}
  .tabs button{flex:1;margin:0;background:var(--panel2);border-color:var(--line);color:var(--dim);font-weight:500}
  .tabs button.on{background:var(--acc);border-color:var(--acc);color:#07101f;font-weight:600}
  .acct{display:flex;justify-content:space-between;align-items:center;gap:10px;
        background:var(--panel);border:1px solid var(--line);border-radius:10px;
        padding:10px 12px;margin-bottom:14px;font-size:13px}
  .acct b{font-weight:600}
  .acct button{width:auto;margin:0;padding:5px 9px;font-size:12px}
  .hist{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px}
  .hist td{padding:6px 4px;border-bottom:1px solid var(--line)}
  .hist td:last-child{text-align:right}
  footer{color:var(--dim);font-size:11px;text-align:center;margin-top:22px;line-height:1.6}
  /* Convite discreto: quem está pagando não pode ser distraído do que veio
     fazer, mas o dono de loja que usa o checkout é justamente quem vale
     convidar. */
  a.convite{display:inline-block;color:var(--acc);font-size:12px;text-decoration:none;
            border:1px solid var(--line);border-radius:8px;padding:8px 14px;margin-top:4px}
</style>
</head>
<body>
<main>
  <h1>Depositar</h1>
  <p class="sub">Você paga, recebe SOL na sua carteira Solana. Ambiente de teste.</p>

  <div class="acct hide" id="acctBar">
    <div>
      <b id="acctEmail">—</b><br>
      <span class="dim mono" id="acctWallet" style="font-size:11px">—</span>
    </div>
    <div style="text-align:right;white-space:nowrap">
      <b id="acctBalance">—</b><br>
      <button class="ghost" id="acctOpen">Minha conta</button>
    </div>
  </div>

  <div class="steps"><div id="s1" class="on"></div><div id="s2"></div></div>
  <div id="alert" class="banner e hide"></div>

  <!-- ── Passo 0: cadastro / entrada ── -->
  <section id="auth">
    <h2>Entre ou crie a sua conta</h2>
    <div class="tabs">
      <button id="tabRegister" class="on">Criar conta</button>
      <button id="tabLogin">Já tenho conta</button>
    </div>
    <p class="dim" id="authHelp" style="font-size:12px;margin:10px 0 0">
      Criamos uma carteira Solana para você no cadastro. Todo SOL que você comprar
      cai sempre nela, e você pode exportar a chave quando quiser.
    </p>

    <label for="email">E-mail</label>
    <input id="email" type="email" autocomplete="email" placeholder="voce@exemplo.com">

    <label for="password">Senha</label>
    <input id="password" type="password" autocomplete="current-password" placeholder="ao menos 8 caracteres">

    <button id="authGo">Criar conta e carteira</button>
  </section>

  <!-- ── Minha conta ── -->
  <!-- ── A carteira é a casa do usuário: saldo e os dois botões ── -->
  <section id="account" class="hide">
    <h2>Sua carteira</h2>

    <div class="box" style="text-align:center;margin-top:0">
      <div class="k">Saldo</div>
      <div class="v pay" id="myBalance">—</div>
      <div class="dim" id="myReceived" style="font-size:12px;margin-top:2px">—</div>
    </div>

    <div class="row" style="margin-top:14px">
      <button id="goDeposit" style="margin:0">Depositar</button>
      <button id="goSend" class="ghost" style="margin:0">Enviar</button>
    </div>

    <div class="box">
      <div class="k">Endereço na rede Solana</div>
      <div class="v mono" id="myWallet">—</div>
      <div class="copy">
        <button class="ghost mini" data-copy="myWallet">Copiar</button>
        <button class="ghost mini" id="myExport">Exportar chave privada</button>
      </div>
    </div>

    <div class="box danger hide" id="mySecretBox">
      <div class="k">Chave privada — mostre a ninguém</div>
      <div class="v mono secret" id="mySecret">—</div>
      <div class="copy"><button class="ghost mini" data-copy="mySecret">Copiar</button></div>
      <p class="dim" style="font-size:11px;margin:8px 0 0">
        Importe no Phantom ou Solflare em "Importar carteira". Quem tem esta chave tem o dinheiro.
      </p>
    </div>

    <div class="box">
      <div class="k">Histórico</div>
      <table class="hist"><tbody id="myHistory"></tbody></table>
    </div>

    <button class="ghost" id="acctLogout">Sair</button>
  </section>

  <!-- ── Enviar: saque para qualquer carteira da rede ── -->
  <section id="send" class="hide">
    <h2>Enviar SOL</h2>

    <label for="wdDest">Para qual endereço</label>
    <input id="wdDest" class="mono" placeholder="Phantom, Solflare, exchange…"
           autocomplete="off" spellcheck="false">

    <div class="row">
      <div>
        <label for="wdAmount">Quanto (SOL)</label>
        <input id="wdAmount" type="number" step="0.000001" min="0" placeholder="0.000000">
      </div>
      <div>
        <label>&nbsp;</label>
        <button class="ghost" id="wdMax" style="margin:0">Tudo</button>
      </div>
    </div>

    <p class="dim" id="wdHelp" style="font-size:12px;margin:8px 0 0">—</p>
    <button id="wdSend">Enviar agora</button>
    <div id="wdResult" style="margin-top:10px"></div>

    <button class="ghost" id="sendBack">Voltar para a carteira</button>
  </section>

  <!-- ── Passo 1: criar a intenção ── -->
  <section id="form" class="hide">
    <h2>Quanto e para onde</h2>

    <label for="method">Forma de pagamento</label>
    <select id="method"></select>

    <div class="row">
      <div>
        <label for="amount">Valor</label>
        <input id="amount" type="number" inputmode="decimal" step="0.01" placeholder="0.00">
      </div>
      <div>
        <label for="currency">Moeda</label>
        <select id="currency"></select>
      </div>
    </div>
    <p class="dim" id="limits" style="font-size:12px;margin:6px 0 0"></p>

    <label class="check" for="genWallet">
      <input type="checkbox" id="genWallet" checked>
      <span>Não tenho carteira — criem uma para mim<br>
        <span class="dim" style="font-size:12px">O SOL cai numa carteira nova, só sua. Você pode
        exportar a chave para o Phantom depois.</span></span>
    </label>

    <div id="walletField" class="hide">
      <label for="wallet">Sua carteira Solana (recebe o SOL)</label>
      <input id="wallet" class="mono" placeholder="Ex.: 7xKX...gAsU" autocomplete="off" spellcheck="false">
    </div>

    <button id="create">Gerar instruções de pagamento</button>
    <button class="ghost hide" id="formBack">Voltar para a carteira</button>
  </section>

  <!-- ── Passo 2: pagar e acompanhar ── -->
  <section id="pay" class="hide">
    <h2>Pague e deixe esta página aberta</h2>

    <div class="box">
      <div class="k">Valor a pagar</div>
      <div class="v pay" id="payAmount">—</div>
      <div class="dim" id="youGet" style="margin-top:6px;font-size:13px">—</div>
    </div>

    <a class="cta hide" id="payNow" href="#" rel="noopener">Pagar com cartão</a>

    <!-- Pix: QR e copia-e-cola, gerados pelo Mercado Pago. -->
    <div class="box hide" id="pixBox">
      <div class="k">Pague com Pix</div>
      <img id="pixQr" alt="QR code Pix" class="hide">
      <button class="ghost mini" id="pixCopy" style="margin-top:2px">Copiar código Pix</button>
      <div class="mono" id="pixCode">—</div>
    </div>

    <!-- Checkout próprio: os campos do cartão são iframes do Mercado Pago. -->
    <div id="cardBrick"></div>
    <div id="cardLoading" class="loading hide">carregando o formulário seguro…</div>
    <p class="dim hide" id="cardFallback" style="font-size:12px;text-align:center;margin-top:12px">
      Problema com o formulário? <a id="cardFallbackLink" href="#" rel="noopener">Pagar na página do Mercado Pago</a>
    </p>

    <div class="box">
      <div class="k" id="payToLabel">Destino</div>
      <div class="v mono" id="payTo">—</div>
      <div class="copy"><button class="ghost mini" data-copy="payTo">Copiar</button><span class="dim" id="holder"></span></div>
    </div>

    <div class="box" id="refBox">
      <div class="k">Referência (obrigatória na descrição)</div>
      <div class="v mono" id="reference">—</div>
      <div class="copy"><button class="ghost mini" data-copy="reference">Copiar</button></div>
    </div>

    <ul id="instructions"></ul>

    <div class="box hide" id="walletBox">
      <div class="k">Sua carteira Solana (o SOL cai aqui)</div>
      <div class="v mono" id="walletAddr">—</div>
      <div class="copy">
        <button class="ghost mini" data-copy="walletAddr">Copiar</button>
        <button class="ghost mini" id="showSecret">Ver chave privada</button>
      </div>
      <div class="box danger hide" id="secretBox" style="margin-top:10px">
        <div class="k">Chave privada — mostre a ninguém</div>
        <div class="v mono secret" id="secretValue">—</div>
        <div class="copy"><button class="ghost mini" data-copy="secretValue">Copiar</button></div>
        <p class="dim" style="font-size:11px;margin:8px 0 0">
          Importe no Phantom ou Solflare com "Importar carteira". Quem tem esta chave tem o dinheiro.
          Guarde fora do navegador — nós não conseguimos recuperá-la para você depois.
        </p>
      </div>
    </div>

    <div class="box">
      <div class="k">Estado</div>
      <div class="v" id="status">—</div>
      <div class="dim" id="statusDetail" style="font-size:12px;margin-top:4px"></div>
    </div>

    <div class="box hide" id="receipt">
      <div class="k">Recebido</div>
      <div class="v ok" id="receivedSol">—</div>
      <div class="mono dim" id="txLink" style="margin-top:6px"></div>
    </div>

    <button class="ghost" id="restart">Voltar para a carteira</button>
  </section>

  <footer>
    O valor em SOL é definido pela cotação no momento da entrega.<br>
    Guarde a sua referência: <span class="mono" id="footRef"></span>
    <br><br>
    <a href="/parceiros" class="convite">Tem uma loja? Faça vendas conosco &rarr;</a>
  </footer>
</main>

<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var options = null;
  var current = null;   // referência em acompanhamento
  var timer = null;

  function alertBox(msg, kind) {
    var el = $('alert');
    if (!msg) { el.className = 'banner e hide'; return; }
    el.className = 'banner ' + (kind || 'e');
    el.textContent = msg;
  }

  // ── Sessão ──
  var SESSION_KEY = 'gw:session';
  var session = null;
  try { session = localStorage.getItem(SESSION_KEY); } catch (e) { /* modo privado */ }

  function setSession(token) {
    session = token;
    try {
      if (token) localStorage.setItem(SESSION_KEY, token);
      else localStorage.removeItem(SESSION_KEY);
    } catch (e) { /* modo privado: a sessão vive só nesta aba */ }
  }

  function api(path, opts) {
    opts = opts || {};
    // A sessão vai em header, nunca na URL: URL vaza em histórico e print.
    if (session) {
      opts.headers = Object.assign({}, opts.headers, { 'x-session': session });
    }
    return fetch(path, opts).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) throw new Error(body && body.message ? body.message : ('erro ' + res.status));
        return body;
      });
    });
  }

  // ── Passo 0: cadastro, entrada e conta ──

  var mode = 'register';
  var account = null;

  function show(id) {
    ['auth', 'account', 'send', 'form', 'pay'].forEach(function (s) {
      $(s).classList.toggle('hide', s !== id);
    });
    $('acctBar').className = account ? 'acct' : 'acct hide';
  }

  function setMode(next) {
    mode = next;
    $('tabRegister').className = next === 'register' ? 'on' : '';
    $('tabLogin').className = next === 'login' ? 'on' : '';
    $('authGo').textContent = next === 'register' ? 'Criar conta e carteira' : 'Entrar';
    $('password').setAttribute('autocomplete', next === 'register' ? 'new-password' : 'current-password');
    $('authHelp').textContent = next === 'register'
      ? 'Criamos uma carteira Solana para você no cadastro. Todo SOL que você comprar cai sempre nela, e você pode exportar a chave quando quiser.'
      : 'Entre para depositar na mesma carteira de sempre.';
    alertBox('');
  }

  function doAuth() {
    alertBox('');
    $('authGo').disabled = true;
    api('/pay/api/auth/' + mode, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: $('email').value, password: $('password').value }),
    }).then(function (res) {
      setSession(res.token);
      $('password').value = '';
      return refreshAccount();
    }).then(function () {
      // Depois do cadastro, a carteira já aparece com saldo e os dois botões.
      show('account');
      return refreshWithdraw();
    }).catch(function (err) {
      alertBox(err.message);
    }).then(function () {
      $('authGo').disabled = false;
    });
  }


  function refreshAccount() {
    if (!session) return Promise.resolve(null);
    return api('/pay/api/account').then(function (acc) {
      account = acc;
      $('acctEmail').textContent = acc.email;
      $('acctWallet').textContent = acc.wallet.address.slice(0, 6) + '…' + acc.wallet.address.slice(-5);
      $('acctBalance').textContent =
        acc.wallet.solBalance === null ? '—' : acc.wallet.solBalance.toFixed(4) + ' SOL';
      $('acctBar').className = 'acct';
      syncAccountUi();

      $('myWallet').textContent = acc.wallet.address;
      $('myBalance').textContent =
        acc.wallet.solBalance === null ? '—' : acc.wallet.solBalance.toFixed(6) + ' SOL';
      $('myReceived').textContent =
        acc.totals.solReceived > 0
          ? 'recebido pelo gateway: ' + acc.totals.solReceived.toFixed(6) + ' SOL'
          : (acc.totals.deposits > 0
              ? acc.totals.deposits + ' depósito(s) pago(s), entrega em processamento'
              : 'nenhum depósito ainda');

      $('myHistory').innerHTML = acc.history.map(function (h) {
        var right;
        if (h.solAmount != null) {
          var sinal = h.solAmount >= 0 ? '+' : '';
          right = '<span class="' + (h.solAmount >= 0 ? 'ok' : 'warn') + '">' +
            sinal + h.solAmount.toFixed(6) + ' SOL</span>';
        } else if (h.state === 'falhou') {
          right = '<span class="err">falhou</span>';
        } else {
          right = '<span class="dim">em processamento</span>';
        }
        return '<tr><td>' + new Date(h.at).toLocaleDateString() +
          '</td><td>' + h.description +
          '</td><td>' + right + '</td></tr>';
      }).join('') || '<tr><td class="dim">nenhuma transação ainda</td></tr>';

      return acc;
    }).catch(function (err) {
      // Sessão vencida ou revogada: volta para a entrada sem drama.
      if (String(err.message).indexOf('login') !== -1) {
        setSession(null);
        account = null;
        show('auth');
      }
      throw err;
    });
  }

  $('tabRegister').addEventListener('click', function () { setMode('register'); });
  $('tabLogin').addEventListener('click', function () { setMode('login'); });
  $('authGo').addEventListener('click', doAuth);
  $('password').addEventListener('keydown', function (e) { if (e.key === 'Enter') doAuth(); });

  $('acctOpen').addEventListener('click', function () {
    alertBox('');
    refreshAccount()
      .then(function () { show('account'); return refreshWithdraw(); })
      .catch(function (err) { alertBox(err.message); });
  });
  $('goDeposit').addEventListener('click', function () {
    alertBox('');
    syncAccountUi();
    show('form');
  });

  $('goSend').addEventListener('click', function () {
    alertBox('');
    $('wdResult').innerHTML = '';
    show('send');
    refreshWithdraw();
  });

  $('sendBack').addEventListener('click', function () {
    alertBox('');
    show('account');
  });

  $('acctLogout').addEventListener('click', function () {
    api('/pay/api/auth/logout', { method: 'POST' }).catch(function () {}).then(function () {
      setSession(null);
      account = null;
      $('mySecretBox').className = 'box danger hide';
      show('auth');
    });
  });

  // ── Saque ──

  var withdrawQuote = null;

  function refreshWithdraw() {
    return api('/pay/api/account/withdraw').then(function (q) {
      withdrawQuote = q;

      // Sem saldo, dizer isso antes é melhor do que deixar o cliente preencher
      // o endereço para receber "saldo insuficiente" no fim.
      var vazio = q.maxSol <= 0;
      $('wdSend').disabled = vazio;
      $('wdMax').disabled = vazio;
      $('wdHelp').textContent = vazio
        ? 'Sua carteira ainda não tem SOL. Faça um depósito primeiro — assim que ele for entregue, ' +
          'o saldo aparece aqui e o envio fica disponível.'
        : 'Disponível para enviar: ' + q.maxSol.toFixed(6) + ' SOL. ' +
          'A taxa de rede sai do saldo, por isso não dá para enviar o saldo inteiro. ' +
          'Endereço novo precisa receber ao menos ' + q.minSol.toFixed(6) + ' SOL para ser criado.';
      return q;
    }).catch(function (err) {
      $('wdHelp').textContent = err.message;
      return null;
    });
  }

  $('wdMax').addEventListener('click', function () {
    if (withdrawQuote) $('wdAmount').value = withdrawQuote.maxSol.toFixed(6);
  });

  $('wdSend').addEventListener('click', function () {
    var dest = $('wdDest').value.trim();
    var amount = $('wdAmount').value ? Number($('wdAmount').value) : undefined;

    if (!dest) { alertBox('Informe o endereço de destino.'); return; }
    if (!confirm('Enviar ' + (amount ? amount + ' SOL' : 'todo o saldo') + ' para:\n\n' + dest +
                 '\n\nTransferência em blockchain não tem estorno. Confira o endereço.')) return;

    alertBox('');
    $('wdSend').disabled = true;
    $('wdResult').innerHTML = '<span class="dim">enviando…</span>';

    api('/pay/api/account/withdraw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(amount === undefined ? { destination: dest } : { destination: dest, amountSol: amount }),
    }).then(function (res) {
      $('wdResult').innerHTML =
        '<span class="ok">Enviado: ' + res.sol.toFixed(6) + ' SOL</span><br>' +
        '<a class="mono" style="font-size:11px" target="_blank" rel="noopener" href="' +
        res.explorer + '">ver na blockchain</a>';
      $('wdDest').value = '';
      $('wdAmount').value = '';
      return Promise.all([refreshAccount(), refreshWithdraw()]);
    }).catch(function (err) {
      $('wdResult').innerHTML = '<span class="err">' + err.message + '</span>';
    }).then(function () {
      $('wdSend').disabled = false;
    });
  });

  $('myExport').addEventListener('click', function () {
    if (!confirm('Mostrar a chave privada da sua carteira?\n\nQuem vir esta chave pode levar o ' +
                 'dinheiro. Só continue se estiver sozinho na frente da tela.')) return;
    $('myExport').disabled = true;
    api('/pay/api/account/wallet/secret', { method: 'POST' }).then(function (secret) {
      $('mySecretBox').className = 'box danger';
      $('mySecret').textContent = secret.secretKeyBase58;
    }).catch(function (err) {
      alertBox(err.message);
    }).then(function () {
      $('myExport').disabled = false;
    });
  });

  // ── Passo 1 ──

  /**
   * Ajusta o formulário ao estado da conta.
   *
   * Fica numa função porque o login acontece DEPOIS do carregamento das
   * opções: fazer isso só uma vez, no início, deixava a tela pedindo carteira
   * a quem acabou de entrar e já tem uma.
   */
  function syncAccountUi() {
    var logged = !!account;
    $('genWallet').parentNode.className = logged ? 'check hide' : 'check';
    $('walletField').className = logged || $('genWallet').checked ? 'hide' : '';
    $('formBack').className = logged ? 'ghost' : 'ghost hide';
  }

  function methodOf(name) {
    for (var i = 0; i < options.methods.length; i++) {
      if (options.methods[i].method === name) return options.methods[i];
    }
    return null;
  }

  function syncCurrencies() {
    var m = methodOf($('method').value);
    if (!m) return;
    $('currency').innerHTML = '';
    m.currencies.forEach(function (c) {
      var o = document.createElement('option');
      o.value = c; o.textContent = c;
      $('currency').appendChild(o);
    });
    // USDC é denominado em USD e não tem escolha de moeda a fazer.
    $('currency').disabled = m.currencies.length < 2;
    $('limits').textContent =
      'Entre ' + options.minAmount + ' e ' + options.maxAmount + ' por depósito. ' +
      (m.autoConfirm
        ? 'Confirmação automática.'
        : 'Confirmação manual pelo operador após a transferência cair.');

  }

  function loadOptions() {
    return api('/pay/api/options').then(function (body) {
      options = body;
      if (!body.enabled) {
        alertBox('Depósitos estão temporariamente desabilitados.', 'w');
        $('create').disabled = true;
        return;
      }
      $('method').innerHTML = '';
      body.methods.forEach(function (m) {
        var o = document.createElement('option');
        o.value = m.method; o.textContent = m.label;
        $('method').appendChild(o);
      });
      syncCurrencies();
      syncAccountUi();
    }).catch(function (err) { alertBox(err.message); });
  }

  function create() {
    alertBox('');
    $('create').disabled = true;
    api('/pay/api/intents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: $('method').value,
        currency: $('currency').value,
        amount: Number($('amount').value),
        // Com conta, o servidor ignora este campo e usa a carteira dela.
        customerWallet: account ? '' : ($('genWallet').checked ? '' : $('wallet').value.trim()),
        // Só usado sem conta: o Pix do MP exige e-mail do pagador.
        email: account ? undefined : $('email').value.trim(),
      }),
    }).then(function (view) {
      // O token de posse vem UMA vez, na criação: é o que prova, depois, que
      // este navegador pode pedir a chave privada da carteira gerada.
      if (view.claimToken) {
        try { localStorage.setItem('claim:' + view.reference, view.claimToken); } catch (e) { /* modo privado */ }
      }
      render(view);
      track(view.reference);
    }).catch(function (err) {
      alertBox(err.message);
    }).then(function () {
      $('create').disabled = false;
    });
  }

  // ── Passo 2 ──

  var LABELS = {
    AWAITING_PAYMENT: 'Aguardando o seu pagamento',
    CONFIRMED: 'Pagamento confirmado',
    EXPIRED: 'Prazo expirado',
    CANCELLED: 'Cancelado',
  };

  var ORDER_LABELS = {
    PENDING: 'em processamento',
    PROCESSING: 'convertendo para SOL',
    SWAPPED: 'convertido — enviando para a sua carteira',
    SETTLED: 'SOL enviado',
    DISTRIBUTED: 'SOL enviado',
    FAILED: 'falhou',
  };

  function render(view) {
    show('pay');
    $('pay').querySelector('h2').textContent =
      view.method === 'CARD' ? 'Pagamento com cartão'
        : view.method === 'PIXQR' ? 'Pague com Pix'
        : 'Pague e deixe esta página aberta';
    $('pay').classList.remove('hide');
    $('s2').className = 'on';

    $('payAmount').textContent = view.amountToPay;

    // O cliente vê o negócio, não a composição: quanto paga e quanto recebe.
    $('youGet').textContent = view.quotedCustomerSol
      ? 'Você recebe aproximadamente ' + Number(view.quotedCustomerSol).toFixed(6) + ' SOL'
      : 'O valor em SOL é calculado na cotação do momento da entrega';

    // Trilho de cartão: o pagamento acontece na página do PSP, então não há
    // destino nem referência para copiar — há um botão.
    var redirect = view.instructions.redirect === true;
    $('payTo').parentNode.className = redirect ? 'box hide' : 'box';

    var embedded = view.method === 'CARD' && options && options.card && options.card.embedded;
    var awaiting = view.status === 'AWAITING_PAYMENT';

    if (view.pix && awaiting) {
      $('pixBox').className = 'box';
      $('pixCode').textContent = view.pix.copyPaste;
      if (view.pix.qrBase64) {
        $('pixQr').src = 'data:image/png;base64,' + view.pix.qrBase64;
        $('pixQr').className = '';
      }
    } else {
      $('pixBox').className = 'box hide';
    }

    if (embedded && awaiting) {
      // Checkout próprio: o cartão é digitado aqui. O link do MP fica como
      // alternativa discreta — não como a chamada principal.
      $('payNow').className = 'cta hide';
      mountCardBrick(view);
      if (view.checkoutUrl) {
        $('cardFallback').className = 'dim';
        $('cardFallbackLink').href = view.checkoutUrl;
      }
    } else if (view.checkoutUrl) {
      $('payNow').className = 'cta';
      $('payNow').href = view.checkoutUrl;
    } else {
      $('payNow').className = 'cta hide';
      if (!awaiting) hideBrick();
    }
    if (!awaiting || !embedded) $('cardFallback').className = 'dim hide';

    $('payTo').textContent = view.instructions.payTo || '(não configurado — fale com o operador)';
    $('payToLabel').textContent =
      view.method === 'USDC' ? 'Endereço de depósito (Solana)' : 'Destino do pagamento';
    $('holder').textContent = view.instructions.holder ? 'Titular: ' + view.instructions.holder : '';
    $('reference').textContent = view.reference;
    $('footRef').textContent = view.reference;
    // Para USDC a referência não vai em lugar nenhum: o que identifica o
    // depósito é o valor exato.
    $('refBox').className = view.method === 'USDC' || redirect ? 'box hide' : 'box';

    $('instructions').innerHTML = '';
    view.instructions.lines.forEach(function (line) {
      var li = document.createElement('li');
      li.textContent = line;
      $('instructions').appendChild(li);
    });

    // A carteira só interessa depois de o depósito existir — e o botão de
    // chave só aparece quando a chave é nossa.
    if (view.wallet && view.wallet.address) {
      $('walletBox').className = 'box';
      $('walletAddr').textContent = view.wallet.address;
      $('showSecret').className = view.wallet.generated ? 'ghost mini' : 'ghost mini hide';
    } else {
      $('walletBox').className = 'box hide';
    }

    var status = $('status');
    status.textContent = LABELS[view.status] || view.status;
    status.className = 'v ' + (view.status === 'CONFIRMED' ? 'ok' : view.status === 'AWAITING_PAYMENT' ? '' : 'warn');

    var detail = '';
    if (view.status === 'AWAITING_PAYMENT') {
      detail = 'Válido até ' + new Date(view.expiresAt).toLocaleTimeString() +
        (view.method === 'CARD' || view.method === 'PIXQR'
          ? ' · consultando o Mercado Pago automaticamente'
          : view.instructions.autoConfirm ? ' · verificando a rede automaticamente' : '');

    } else if (view.order) {
      /**
       * "Aguardando lastro" é um estado normal do modelo de conversão manual,
       * não um erro: o pagamento entrou e a entrega depende do operador
       * abastecer o vault. Mostrar a mensagem técnica aqui assustaria o
       * cliente sem informá-lo.
       */
      var waiting = (view.order.lastError || '').indexOf('AGUARDANDO_LASTRO') === 0;
      if (waiting) {
        detail = 'Pagamento confirmado. A entrega do seu SOL está em processamento — ' +
          'você não precisa fazer mais nada, o saldo aparece aqui e na sua carteira.';
      } else {
        detail = 'Ordem ' + (ORDER_LABELS[view.order.status] || view.order.status);
        if (view.order.status === 'FAILED' && view.order.lastError) {
          detail += ' — ' + view.order.lastError;
        }
      }
    }
    $('statusDetail').textContent = detail;

    var done = view.order && view.order.customerSol !== null;
    $('receipt').className = done ? 'box' : 'box hide';
    if (done) {
      $('receivedSol').textContent = view.order.customerSol.toFixed(6) + ' SOL';
      $('txLink').innerHTML = view.order.payoutSignature
        ? 'tx: <a target="_blank" rel="noopener" href="https://solscan.io/tx/' +
          encodeURIComponent(view.order.payoutSignature) + '">' +
          view.order.payoutSignature.slice(0, 24) + '…</a>'
        : '';
    }

    if (view.status === 'EXPIRED') {
      alertBox('O prazo desta referência passou. Se você já pagou, fale com o operador — ' +
        'o pagamento ainda pode ser confirmado.', 'w');
    } else if (view.order && (view.order.lastError || '').indexOf('AGUARDANDO_LASTRO') === 0) {
      alertBox('Pagamento recebido. A entrega do SOL está em processamento.', 'o');
    } else if (view.order && view.order.status === 'FAILED') {
      alertBox('A ordem falhou depois do pagamento. Guarde a referência e fale com o operador.', 'e');
    } else if (view.order && (view.order.status === 'SETTLED' || view.order.status === 'DISTRIBUTED')) {
      alertBox('Pronto: o SOL foi enviado para a sua carteira.', 'o');
      // O saldo na barra tem de refletir o dinheiro que acabou de chegar.
      if (session) refreshAccount().catch(function () {});
    }
  }

  // ── Checkout de cartão embutido (Brick do Mercado Pago) ──

  var brickMounted = false;
  var sdkPromise = null;

  /** Carrega o SDK do MP uma vez, sob demanda. */
  function loadSdk() {
    if (sdkPromise) return sdkPromise;
    sdkPromise = new Promise(function (resolve, reject) {
      if (window.MercadoPago) return resolve();
      var el = document.createElement('script');
      el.src = 'https://sdk.mercadopago.com/js/v2';
      el.onload = function () { resolve(); };
      el.onerror = function () { reject(new Error('não foi possível carregar o Mercado Pago')); };
      document.head.appendChild(el);
    });
    return sdkPromise;
  }

  function mountCardBrick(view) {
    if (brickMounted) return;
    brickMounted = true;
    $('cardLoading').className = 'loading';

    loadSdk().then(function () {
      var mp = new window.MercadoPago(options.card.publicKey, { locale: 'pt-BR' });
      return mp.bricks().create('cardPayment', 'cardBrick', {
        initialization: { amount: Number(view.fiatAmount) },
        customization: {
          visual: { style: { theme: 'dark' } },
          // Parcelamento fica fora: o custo do MP sobe com as parcelas e sairia
          // da nossa margem sem o cliente ver diferença nenhuma.
          paymentMethods: { maxInstallments: 1 },
        },
        callbacks: {
          onReady: function () { $('cardLoading').className = 'loading hide'; },
          onError: function (err) {
            alertBox((err && err.message) ? err.message : 'erro no formulário de cartão');
          },
          onSubmit: function (formData) {
            alertBox('');
            return api('/pay/api/intents/' + encodeURIComponent(view.reference) + '/pay', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                token: formData.token,
                paymentMethodId: formData.payment_method_id,
                installments: formData.installments,
                issuerId: formData.issuer_id,
                payerEmail: formData.payer && formData.payer.email,
                payerDocType: formData.payer && formData.payer.identification && formData.payer.identification.type,
                payerDocNumber: formData.payer && formData.payer.identification && formData.payer.identification.number,
              }),
            }).then(function (outcome) {
              if (outcome.status === 'approved') {
                alertBox('Pagamento aprovado. Estamos comprando o seu SOL.', 'o');
                hideBrick();
              } else if (outcome.status === 'pending') {
                alertBox(outcome.message, 'w');
              }
              poll();
            }).catch(function (err) {
              // Recusa do cartão volta como 402 com a explicação do emissor;
              // erro do PSP (credencial, indisponibilidade) volta como 400.
              alertBox(err.message);
              if ($('cardFallbackLink').href && $('cardFallbackLink').href !== '#') {
                $('cardFallback').className = 'dim';
              }
              throw err;
            });
          },
        },
      });
    }).catch(function (err) {
      brickMounted = false;
      $('cardLoading').className = 'loading hide';
      alertBox(err.message);
    });
  }

  function hideBrick() {
    $('pixBox').className = 'box hide';
    $('cardFallback').className = 'dim hide';
    $('cardBrick').innerHTML = '';
    $('cardLoading').className = 'loading hide';
  }

  function track(reference) {
    current = reference;
    try { history.replaceState(null, '', '?ref=' + reference); } catch (e) { /* file:// */ }
    poll();
  }

  function poll() {
    if (!current) return;
    if (timer) { clearTimeout(timer); timer = null; }

    api('/pay/api/intents/' + encodeURIComponent(current)).then(function (view) {
      render(view);
      var settled = view.order && (view.order.status === 'SETTLED' || view.order.status === 'DISTRIBUTED');
      var dead = view.status === 'CANCELLED' || (view.order && view.order.status === 'FAILED');
      // Antes de confirmar, o poll é o que dispara a varredura on-chain — daí
      // o intervalo curto. Depois, é só acompanhamento da pipeline.
      if (!settled && !dead) timer = setTimeout(poll, view.status === 'AWAITING_PAYMENT' ? 6000 : 4000);
    }).catch(function (err) {
      alertBox(err.message);
      timer = setTimeout(poll, 15000);
    });
  }

  document.addEventListener('click', function (ev) {
    var target = ev.target.getAttribute && ev.target.getAttribute('data-copy');
    if (!target) return;
    var text = $(target).textContent;
    var done = function () {
      var old = ev.target.textContent;
      ev.target.textContent = 'Copiado';
      setTimeout(function () { ev.target.textContent = old; }, 1200);
    };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, function () {});
    else done();
  });

  $('formBack').addEventListener('click', function () { alertBox(''); show('account'); });

  $('genWallet').addEventListener('change', function () {
    $('walletField').className = $('genWallet').checked ? 'hide' : '';
  });

  $('showSecret').addEventListener('click', function () {
    var token = null;
    try { token = localStorage.getItem('claim:' + current); } catch (e) { /* modo privado */ }
    if (!token) {
      alertBox('A chave só é entregue ao navegador que criou este depósito. ' +
               'Se você trocou de aparelho, fale com o operador.');
      return;
    }
    if (!confirm('Mostrar a chave privada?\n\nQuem vir esta chave pode levar o dinheiro. ' +
                 'Só continue se estiver sozinho na frente da tela.')) return;

    $('showSecret').disabled = true;
    api('/pay/api/intents/' + encodeURIComponent(current) + '/wallet', {
      method: 'POST',
      headers: { 'x-claim-token': token },
    }).then(function (secret) {
      $('secretBox').className = 'box danger';
      $('secretValue').textContent = secret.secretKeyBase58;
    }).catch(function (err) {
      alertBox(err.message);
    }).then(function () {
      $('showSecret').disabled = false;
    });
  });

  $('pixCopy').addEventListener('click', function () {
    var text = $('pixCode').textContent;
    var done = function () {
      $('pixCopy').textContent = 'Copiado';
      setTimeout(function () { $('pixCopy').textContent = 'Copiar código Pix'; }, 1500);
    };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, function () {});
    else done();
  });

  $('method').addEventListener('change', syncCurrencies);
  $('create').addEventListener('click', create);
  $('restart').addEventListener('click', function () {
    // Com conta, o lugar natural de voltar é a carteira — é lá que o saldo
    // acabou de mudar.
    if (account) {
      current = null;
      brickMounted = false;
      hideBrick();
      try { history.replaceState(null, '', location.pathname); } catch (e) { /* noop */ }
      alertBox('');
      refreshAccount().catch(function () {});
      refreshWithdraw();
      show('account');
      return;
    }
    current = null;
    brickMounted = false;
    hideBrick();
    if (timer) clearTimeout(timer);
    try { history.replaceState(null, '', location.pathname); } catch (e) { /* noop */ }
    $('secretBox').className = 'box danger hide';
    $('secretValue').textContent = '—';
    show('form');
    $('s2').className = '';
    alertBox('');
  });

  // Registrar o service worker é o que faz o Android oferecer "instalar".
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/pwa/sw.js', { scope: '/pay' }).catch(function () {});
  }

  setMode('register');

  var fromUrl = (location.search.match(/[?&]ref=([^&]+)/) || [])[1];

  // Com sessão válida, entra direto no formulário; sem ela, pede cadastro.
  // O acompanhamento de um depósito por URL funciona nos dois casos — quem
  // recebeu o link não precisa ter conta para ver o estado.
  (session ? refreshAccount().catch(function () { return null; }) : Promise.resolve(null))
    .then(function () {
      return loadOptions();
    })
    .then(function () {
      if (fromUrl) track(decodeURIComponent(fromUrl));
      else if (account) { show('account'); refreshWithdraw(); }
      else show('auth');
    });
})();
</script>
</body>
</html>`;
