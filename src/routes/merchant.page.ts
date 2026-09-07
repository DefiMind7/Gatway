/**
 * Portal da loja — página única, embutida.
 *
 * O dono da loja vê o que ganhou e pede o saque. Nada além disso: quanto menos
 * a tela oferece, menos há para entender antes de usar.
 */
export const MERCHANT_PAGE_HTML = String.raw`<!doctype html>
<html lang="pt">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#0f1216">
<title>Minha loja — faturamento</title>
<style>
  :root{--bg:#0f1216;--panel:#171b21;--panel2:#1e242c;--line:#2a323c;--tx:#e6eaef;--dim:#94a1b2;--ok:#3ddc97;--warn:#ffb84d;--err:#ff6b6b;--acc:#5b9dff}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--tx);
       font:15px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  main{max-width:760px;margin:0 auto;
       padding:calc(22px + env(safe-area-inset-top)) 16px calc(56px + env(safe-area-inset-bottom))}
  h1{font-size:20px;margin:0}
  section{background:var(--panel);border:1px solid var(--line);border-radius:12px;
          padding:18px;margin-bottom:14px}
  h2{font-size:12px;text-transform:uppercase;letter-spacing:.07em;color:var(--dim);margin:0 0 14px}
  label{display:block;font-size:12px;color:var(--dim);margin:12px 0 5px}
  input,button,select{font:inherit;color:var(--tx);background:var(--panel2);
    border:1px solid var(--line);border-radius:8px;padding:11px 12px;width:100%;min-height:44px}
  input:focus{outline:1px solid var(--acc)}
  button{cursor:pointer;background:var(--acc);border-color:var(--acc);color:#07101f;
         font-weight:650;margin-top:16px}
  button.ghost{background:var(--panel2);border-color:var(--line);color:var(--tx);font-weight:500}
  button.mini{width:auto;padding:6px 10px;font-size:12px;min-height:34px;margin:0}
  button:disabled{opacity:.5;cursor:not-allowed}
  .topo{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:16px}
  .cartoes{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
  .cartao{background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:14px}
  .cartao span{font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em}
  .cartao b{display:block;font-size:22px;font-weight:650;margin-top:4px}
  .cartao.destaque b{color:var(--ok)}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line)}
  th{color:var(--dim);font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
  td.num{text-align:right;font-family:ui-monospace,Menlo,monospace}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;word-break:break-all}
  .dim{color:var(--dim)}.ok{color:var(--ok)}.warn{color:var(--warn)}.err{color:var(--err)}
  .banner{padding:11px 13px;border-radius:8px;font-size:13px;border:1px solid;margin-bottom:14px}
  .banner.e{background:#3a1a1a;border-color:#6b2a2a;color:#ffc4c4}
  .banner.o{background:#12312a;border-color:#1f5f4f;color:#b6f0dc}
  .hide{display:none!important}
  .scroll{overflow-x:auto}
  @media (max-width:640px){
    .scroll table,.scroll thead,.scroll tbody,.scroll th,.scroll td,.scroll tr{display:block}
    .scroll thead{position:absolute;left:-9999px}
    .scroll tr{background:var(--panel2);border:1px solid var(--line);border-radius:8px;
               padding:8px 10px;margin-bottom:8px}
    .scroll td{border:0;padding:3px 0;display:flex;justify-content:space-between;gap:10px}
    .scroll td::before{content:attr(data-l);color:var(--dim);font-size:11px;text-transform:uppercase}
    .scroll td.num{text-align:left}
  }
</style>
</head>
<body>
<main>
  <div class="topo">
    <h1>Minha loja</h1>
    <button class="ghost mini hide" id="sair">Sair</button>
  </div>

  <div id="alert" class="banner e hide"></div>

  <!-- ── Entrada ── -->
  <section id="login">
    <h2>Entrar</h2>
    <label for="email">E-mail</label>
    <input id="email" type="email" autocomplete="username" placeholder="contato@sualoja.com">
    <label for="password">Senha</label>
    <input id="password" type="password" autocomplete="current-password">
    <button id="entrar">Entrar</button>
    <p class="dim" style="font-size:12px;margin:14px 0 0">
      As credenciais são enviadas quando o seu pedido de integração é aprovado.
      Ainda não pediu? <a href="/parceiros" style="color:var(--acc)">comece aqui</a>.
    </p>
  </section>

  <!-- ── Painel ── -->
  <div id="painel" class="hide">
    <section>
      <h2>Faturamento</h2>
      <div class="cartoes">
        <div class="cartao destaque"><span>Disponível para saque</span><b id="saldo">—</b></div>
        <div class="cartao"><span>Vendas (líquido)</span><b id="vendas">—</b></div>
        <div class="cartao"><span>Já sacado</span><b id="sacado">—</b></div>
        <div class="cartao"><span>Vendas pagas</span><b id="qtd">—</b></div>
      </div>
      <p class="dim" style="font-size:12px;margin:12px 0 0" id="comissao">—</p>
    </section>

    <section>
      <h2>Sacar</h2>

      <label for="metodo">Como você quer receber</label>
      <select id="metodo">
        <option value="SOL">Cripto — SOL na sua carteira</option>
        <option value="FIAT">Dinheiro — transferência bancária</option>
      </select>

      <!-- ── cripto ── -->
      <div id="blocoSol">
        <label for="wallet">Sua carteira Solana</label>
        <input id="wallet" class="mono" placeholder="Cole o endereço que vai receber" spellcheck="false">
      </div>

      <!-- ── fiat ── -->
      <div id="blocoFiat" class="hide">
        <label for="moeda">Moeda</label>
        <select id="moeda">
          <option value="BRL">Real (BRL)</option>
          <option value="USD">Dólar (USD)</option>
          <option value="EUR">Euro (EUR)</option>
        </select>

        <label for="dadosFiat">Conta que vai receber</label>
        <input id="dadosFiat" placeholder="Chave Pix, IBAN ou dados bancários">
        <p class="dim" style="font-size:11px;margin:5px 0 0">
          Em BRL, a chave Pix basta. Em dólar ou euro, informe IBAN/SWIFT e o titular.
        </p>
      </div>

      <button class="ghost" id="salvarPreferencias" style="margin-top:10px">Salvar como padrão</button>

      <label for="valor" style="margin-top:18px">Quanto sacar (BRL)</label>
      <input id="valor" type="number" step="0.01" min="10" placeholder="0,00">
      <p class="dim" style="font-size:12px;margin:6px 0 0" id="ajudaSaque">—</p>
      <p class="dim" style="font-size:12px;margin:4px 0 0" id="estimativa"></p>
      <button id="pedirSaque">Pedir saque</button>
    </section>

    <section>
      <h2>Saques</h2>
      <div class="scroll"><table id="tabelaSaques"><thead><tr>
        <th>Quando</th><th>Valor</th><th>Forma</th><th>Estado</th><th>Comprovante</th>
      </tr></thead><tbody></tbody></table></div>
    </section>

    <section>
      <h2>Vendas recentes</h2>
      <div class="scroll"><table id="tabelaVendas"><thead><tr>
        <th>Quando</th><th>Referência</th><th>Pedido</th><th>Valor</th><th>Estado</th>
      </tr></thead><tbody></tbody></table></div>
    </section>

    <section>
      <h2>Integração</h2>
      <p class="dim" style="font-size:13px;margin:0 0 8px">
        Chave de API: <span class="mono" id="chave">—</span> ·
        <a href="/docs" target="_blank" rel="noopener" style="color:var(--acc)">documentação</a>
      </p>
      <p class="dim" style="font-size:12px;margin:0">
        A chave completa só aparece quando é emitida. Perdeu? Peça uma nova ao operador.
      </p>
    </section>
  </div>
</main>

<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var CHAVE_SESSAO = 'gw:merchant';
  var sessao = null;
  try { sessao = localStorage.getItem(CHAVE_SESSAO); } catch (e) { /* modo privado */ }

  function guardar(token) {
    sessao = token;
    try {
      if (token) localStorage.setItem(CHAVE_SESSAO, token);
      else localStorage.removeItem(CHAVE_SESSAO);
    } catch (e) { /* modo privado */ }
  }

  function alerta(msg, tipo) {
    var el = $('alert');
    if (!msg) { el.className = 'banner e hide'; return; }
    el.className = 'banner ' + (tipo || 'e');
    el.textContent = msg;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function api(caminho, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers);
    if (sessao) opts.headers['x-merchant-session'] = sessao;
    return fetch('/loja' + caminho, opts).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) throw new Error(body && body.message ? body.message : 'erro ' + res.status);
        return body;
      });
    });
  }

  var brl = function (v) { return 'R$ ' + Number(v).toFixed(2).replace('.', ','); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  };

  var ESTADO_SAQUE = {
    pendente: '<span class="warn">em análise</span>',
    aprovado: '<span class="warn">processando</span>',
    enviado: '<span class="ok">enviado</span>',
    recusado: '<span class="err">recusado</span>'
  };
  var ESTADO_VENDA = {
    CONFIRMED: '<span class="ok">paga</span>',
    AWAITING_PAYMENT: '<span class="dim">aguardando</span>',
    EXPIRED: '<span class="dim">expirou</span>',
    CANCELLED: '<span class="dim">cancelada</span>'
  };

  function mostrar(dados) {
    $('login').classList.add('hide');
    $('painel').classList.remove('hide');
    $('sair').classList.remove('hide');

    var b = dados.balance;
    $('saldo').textContent = brl(b.available);
    $('vendas').textContent = brl(b.totalSales);
    $('sacado').textContent = brl(b.totalWithdrawn);
    $('qtd').textContent = b.salesCount;
    $('comissao').textContent =
      'Comissão do gateway: ' + (dados.merchant.commissionBps / 100).toFixed(2) +
      '% sobre cada venda. Já retido: ' + brl(b.totalCommission) + '.';

    if (dados.merchant.payoutWallet) $('wallet').value = dados.merchant.payoutWallet;
    if (dados.merchant.payoutFiatDetails) $('dadosFiat').value = dados.merchant.payoutFiatDetails;
    if (dados.merchant.payoutCurrency) $('moeda').value = dados.merchant.payoutCurrency;
    if (dados.merchant.preferredPayout) $('metodo').value = dados.merchant.preferredPayout;
    trocarMetodo();
    $('chave').textContent = dados.merchant.apiKeyPrefix + '…';
    $('ajudaSaque').textContent =
      'Disponível: ' + brl(b.available) + '. Mínimo de R$ 10,00. ' +
      'O valor sai do saldo assim que você pede, e é convertido em SOL pela cotação do momento do envio.';

    document.querySelector('#tabelaSaques tbody').innerHTML = (dados.withdrawals || []).map(function (s) {
      var cripto = s.method !== 'FIAT';

      var comprovante;
      if (cripto) {
        comprovante = s.signature
          ? '<a class="mono" target="_blank" rel="noopener" href="https://solscan.io/tx/' +
            esc(s.signature) + '">ver na blockchain</a>' +
            (s.solSent ? '<br><span class="dim" style="font-size:11px">' + esc(s.solSent) + ' SOL</span>' : '')
          : (s.note ? '<span class="dim">' + esc(s.note) + '</span>' : '<span class="dim">—</span>');
      } else {
        comprovante = s.sent
          ? '<span class="ok">' + esc(s.sent) + ' ' + esc(s.payoutCurrency) + ' transferidos</span>'
          : (s.note ? '<span class="dim">' + esc(s.note) + '</span>' : '<span class="dim">—</span>');
      }

      var forma = cripto
        ? '<span class="dim">SOL</span>'
        : '<span class="dim">' + esc(s.payoutCurrency) +
          (s.estimated && !s.sent ? ' · ~' + esc(s.estimated) : '') + '</span>';

      return '<tr>' +
        '<td data-l="Quando" class="dim">' + new Date(s.createdAt).toLocaleString() + '</td>' +
        '<td data-l="Valor" class="num">' + brl(s.amount) + '</td>' +
        '<td data-l="Forma">' + forma + '</td>' +
        '<td data-l="Estado">' + (ESTADO_SAQUE[s.status] || esc(s.status)) + '</td>' +
        '<td data-l="Comprovante">' + comprovante + '</td></tr>';
    }).join('') || '<tr><td class="dim">nenhum saque ainda</td></tr>';

    document.querySelector('#tabelaVendas tbody').innerHTML = (dados.sales || []).map(function (v) {
      return '<tr>' +
        '<td data-l="Quando" class="dim">' + new Date(v.createdAt).toLocaleString() + '</td>' +
        '<td data-l="Referência" class="mono">' + esc(v.reference) + '</td>' +
        '<td data-l="Pedido" class="dim">' + esc(v.externalId || '—') + '</td>' +
        '<td data-l="Valor" class="num">' + esc(v.amount) + '</td>' +
        '<td data-l="Estado">' + (ESTADO_VENDA[v.status] || esc(v.status)) + '</td></tr>';
    }).join('') || '<tr><td class="dim">nenhuma venda ainda</td></tr>';
  }

  function carregar() {
    return api('/api/dashboard').then(mostrar).catch(function (err) {
      if (String(err.message).indexOf('login') !== -1) {
        guardar(null);
        $('painel').classList.add('hide');
        $('login').classList.remove('hide');
        $('sair').classList.add('hide');
      } else {
        alerta(err.message);
      }
    });
  }

  $('entrar').addEventListener('click', function () {
    alerta('');
    $('entrar').disabled = true;
    api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ email: $('email').value.trim(), password: $('password').value })
    }).then(function (r) {
      guardar(r.token);
      $('password').value = '';
      return carregar();
    }).catch(function (err) {
      alerta(err.message);
    }).then(function () { $('entrar').disabled = false; });
  });

  $('password').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') $('entrar').click();
  });

  $('sair').addEventListener('click', function () {
    api('/api/logout', { method: 'POST' }).catch(function () {}).then(function () {
      guardar(null);
      location.reload();
    });
  });

  function trocarMetodo() {
    var fiat = $('metodo').value === 'FIAT';
    $('blocoSol').className = fiat ? 'hide' : '';
    $('blocoFiat').className = fiat ? '' : 'hide';
    atualizarEstimativa();
  }

  /**
   * Mostra quanto sai na moeda escolhida.
   *
   * É estimativa e a tela diz isso: quem transfere é o operador, pelo câmbio
   * do banco dele no dia. Apresentar como valor fechado criaria uma promessa
   * que a transferência real pode desmentir.
   */
  function atualizarEstimativa() {
    var el = $('estimativa');
    var valor = Number($('valor').value);
    if ($('metodo').value !== 'FIAT' || !(valor > 0)) { el.textContent = ''; return; }

    var moeda = $('moeda').value;
    if (moeda === 'BRL') {
      el.textContent = 'Você recebe ' + brl(valor) + ' na conta informada.';
    } else {
      el.textContent = 'O valor em ' + moeda + ' é calculado no câmbio do dia da transferência.';
    }
  }

  $('metodo').addEventListener('change', trocarMetodo);
  $('moeda').addEventListener('change', atualizarEstimativa);
  $('valor').addEventListener('input', atualizarEstimativa);

  $('salvarPreferencias').addEventListener('click', function () {
    alerta('');
    api('/api/payout-settings', {
      method: 'POST',
      body: JSON.stringify({
        wallet: $('wallet').value.trim(),
        preferred: $('metodo').value,
        currency: $('moeda').value,
        fiatDetails: $('dadosFiat').value.trim()
      })
    }).then(function () {
      alerta('Preferências salvas.', 'o');
      carregar();
    }).catch(function (err) { alerta(err.message); });
  });

  $('pedirSaque').addEventListener('click', function () {
    alerta('');
    var valor = Number($('valor').value);
    var fiat = $('metodo').value === 'FIAT';
    var carteira = $('wallet').value.trim();
    var dadosFiat = $('dadosFiat').value.trim();

    if (!(valor > 0)) { alerta('Informe o valor do saque.'); return; }
    if (!fiat && !carteira) { alerta('Informe a carteira que vai receber.'); return; }
    if (fiat && !dadosFiat) { alerta('Informe a conta que vai receber.'); return; }

    var destino = fiat ? dadosFiat + ' (' + $('moeda').value + ')' : carteira;
    if (!confirm('Pedir saque de ' + brl(valor) + ' para:\n\n' + destino +
                 '\n\nO valor sai do seu saldo agora e o envio acontece após a análise.')) return;

    $('pedirSaque').disabled = true;
    api('/api/withdrawals', {
      method: 'POST',
      body: JSON.stringify({
        amount: valor,
        method: $('metodo').value,
        wallet: carteira,
        currency: $('moeda').value,
        fiatDetails: dadosFiat
      })
    }).then(function () {
      alerta('Saque solicitado. Você acompanha o estado na tabela abaixo.', 'o');
      $('valor').value = '';
      return carregar();
    }).catch(function (err) {
      alerta(err.message);
    }).then(function () { $('pedirSaque').disabled = false; });
  });

  if (sessao) carregar();
})();
</script>
</body>
</html>`;
