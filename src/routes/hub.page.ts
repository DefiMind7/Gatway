/**
 * `/inicio` — a escolha da operação, depois do login.
 *
 * É onde as três portas passaram a morar. Antes elas estavam na raiz, abertas
 * a quem nunca tinha se cadastrado, e todas desembocavam num formulário de
 * login mais adiante — a escolha vinha antes de haver quem escolhesse.
 *
 * A porta da loja muda de texto conforme o estado, e é isso que faz o funil
 * funcionar: quem não tem loja é convidado a abrir uma, quem tem entra na
 * dela, e quem está esperando análise vê que está esperando sem precisar
 * clicar para descobrir.
 *
 * Cuidado ao editar: o corpo vive dentro de String.raw. Crase aqui encerra o
 * literal — o JS desta página concatena com +, sem template literal.
 */
export const HUB_PAGE_HTML = String.raw`<!doctype html>
<html lang="pt">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0f1216">
<title>Início</title>
<style>
  :root{--bg:#0f1216;--panel:#171b21;--panel2:#1e242c;--line:#2a323c;--tx:#e6eaef;--dim:#94a1b2;--ok:#3ddc97;--warn:#ffb84d;--err:#ff6b6b;--acc:#5b9dff}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--tx);
       font:15px/1.65 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  main{max-width:660px;margin:0 auto;
       padding:calc(30px + env(safe-area-inset-top)) 20px calc(60px + env(safe-area-inset-bottom))}
  .topo{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:30px}
  h1{font-size:24px;line-height:1.25;margin:0 0 4px;letter-spacing:-.02em}
  .quem{color:var(--dim);font-size:13px}
  button{font:inherit;cursor:pointer;background:var(--panel);border:1px solid var(--line);
         color:var(--tx);border-radius:8px;padding:7px 12px;font-size:13px}
  a.porta{display:block;text-decoration:none;color:inherit;background:var(--panel);
          border:1px solid var(--line);border-radius:14px;padding:20px;margin-bottom:12px;
          transition:border-color .15s}
  a.porta:hover{border-color:var(--acc)}
  a.porta b{display:block;font-size:17px;font-weight:650;margin-bottom:3px}
  a.porta span{color:var(--dim);font-size:14px}
  a.porta .seta{float:right;color:var(--acc);font-size:18px;line-height:1.2}
  .destaque{border-color:#2c4a7a;background:linear-gradient(180deg,#1a2130,var(--panel))}
  .selo{display:inline-block;font-size:11px;padding:2px 8px;border-radius:20px;margin-left:8px;
        vertical-align:middle;background:var(--panel2);border:1px solid var(--line);color:var(--dim)}
  .selo.ok{color:var(--ok);border-color:#1f5f4f}
  .selo.warn{color:var(--warn);border-color:#5c4a1c}
  .selo.err{color:var(--err);border-color:#6b2a2a}
  .carteira{background:var(--panel2);border:1px solid var(--line);border-radius:12px;
            padding:14px 16px;margin-bottom:22px}
  .carteira .r{display:flex;justify-content:space-between;gap:12px;align-items:baseline}
  .carteira .v{font-size:20px;font-weight:650}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;word-break:break-all;
        color:var(--dim)}
  footer{color:var(--dim);font-size:12px;margin-top:30px;text-align:center;line-height:1.9}
  a{color:var(--acc)}
  .hide{display:none!important}
</style>
</head>
<body>
<main>
  <div class="topo">
    <div>
      <h1>O que você quer fazer?</h1>
      <div class="quem" id="quem">—</div>
    </div>
    <button id="sair">Sair</button>
  </div>

  <div class="carteira" id="carteira">
    <div class="r">
      <span class="quem">Sua carteira</span>
      <span class="v" id="saldo">—</span>
    </div>
    <div class="mono" id="endereco" style="margin-top:6px">—</div>
  </div>

  <a class="porta" href="/pay">
    <span class="seta">&rarr;</span>
    <b>Comprar SOL</b>
    <span>Pague por Pix ou cartão e receba na sua carteira.</span>
  </a>

  <a class="porta destaque" href="/loja" id="portaLoja">
    <span class="seta">&rarr;</span>
    <b id="lojaTitulo">Faça vendas conosco</b>
    <span id="lojaTexto">Coloque o nosso checkout na sua loja e receba como preferir.</span>
  </a>

  <a class="porta" href="/pay#conta" id="portaCarteira">
    <span class="seta">&rarr;</span>
    <b>Minha carteira</b>
    <span>Saldo, histórico de compras, envio para outra carteira e a sua chave privada.</span>
  </a>

  <footer>
    <a href="/docs">Documentação da API</a>
  </footer>
</main>

<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var CHAVE = 'gw:session';
  var sessao = null;
  try { sessao = localStorage.getItem(CHAVE); } catch (e) { /* modo privado */ }

  // Sem sessão não há hub: esta página inteira pressupõe alguém.
  if (!sessao) { location.href = '/conta'; return; }

  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  };

  function sair() {
    fetch('/pay/api/auth/logout', { method: 'POST', headers: { 'x-session': sessao } })
      .catch(function () {})
      .then(function () {
        try { localStorage.removeItem(CHAVE); } catch (e) { /* modo privado */ }
        location.href = '/';
      });
  }
  $('sair').addEventListener('click', sair);

  // ── quem é a pessoa, e quanto tem ──
  fetch('/pay/api/account', { headers: { 'x-session': sessao } })
    .then(function (r) {
      if (r.status === 401 || r.status === 400) {
        try { localStorage.removeItem(CHAVE); } catch (e) { /* modo privado */ }
        location.href = '/conta';
        throw new Error('sessão expirada');
      }
      return r.json();
    })
    .then(function (d) {
      $('quem').textContent = d.email;
      $('endereco').textContent = d.wallet.address;
      $('saldo').textContent =
        d.wallet.solBalance == null ? '—' : Number(d.wallet.solBalance).toFixed(6) + ' SOL';
    })
    .catch(function () { /* já redirecionou, ou a chain não respondeu */ });

  // ── a porta da loja muda conforme o estado ──
  var ESTADOS = {
    sem_pedido: {
      titulo: 'Minha loja',
      selo: '<span class="selo">falta pedir análise</span>',
      texto: 'Você abriu a loja mas ela ainda não pode cobrar. Envie os dados da empresa.'
    },
    em_analise: {
      titulo: 'Minha loja',
      selo: '<span class="selo warn">em análise</span>',
      texto: 'Estamos analisando o seu pedido. A resposta aparece no painel da loja.'
    },
    aprovado: {
      titulo: 'Minha loja',
      selo: '<span class="selo ok">aprovada</span>',
      texto: 'Faturamento, saques e as suas credenciais de integração.'
    },
    recusado: {
      titulo: 'Minha loja',
      selo: '<span class="selo err">pedido recusado</span>',
      texto: 'Veja o motivo no painel e envie um novo pedido.'
    }
  };

  fetch('/loja/api/me', { headers: { 'x-session': sessao } })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d.hasStore) return;
      var e = ESTADOS[d.store.status] || ESTADOS.sem_pedido;
      $('lojaTitulo').innerHTML = esc(d.store.name) + e.selo;
      $('lojaTexto').textContent = e.texto;
    })
    .catch(function () { /* mantém o convite genérico */ });
})();
</script>
</body>
</html>`;
