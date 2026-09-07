/**
 * Painel do admin — página única, embutida como string.
 *
 * Embutir em vez de servir um arquivo estático é deliberado: `tsc` não copia
 * assets para `dist/`, e um passo extra de build só para um HTML seria mais
 * frágil do que isto. Sem CDN, sem framework — tudo inline.
 *
 * A página não contém segredo nenhum: pede a ADMIN_API_KEY, guarda em
 * sessionStorage (morre ao fechar a aba) e chama /admin/api/*.
 */
export const ADMIN_PAGE_HTML = String.raw`<!doctype html>
<html lang="pt">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#0f1216">
<link rel="manifest" href="/pwa/admin.webmanifest">
<link rel="apple-touch-icon" href="/pwa/icon-192.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Painel">
<meta name="mobile-web-app-capable" content="yes">
<title>Gateway — Admin</title>
<style>
  :root{--bg:#0f1216;--panel:#171b21;--panel2:#1e242c;--line:#2a323c;--tx:#e6eaef;--dim:#94a1b2;--ok:#3ddc97;--warn:#ffb84d;--err:#ff6b6b;--acc:#5b9dff}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--tx);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  header{padding:16px 20px;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:center;flex-wrap:wrap}
  h1{font-size:16px;margin:0;font-weight:600}
  main{padding:20px;max-width:1180px;margin:0 auto;display:grid;gap:16px}
  section{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px}
  h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);margin:0 0 12px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
  .kpi{background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:12px}
  .kpi b{display:block;font-size:20px;font-weight:600;margin-top:4px}
  .kpi span{color:var(--dim);font-size:12px}
  label{display:block;font-size:12px;color:var(--dim);margin:8px 0 4px}
  input,select,button{font:inherit;color:var(--tx);background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:8px 10px}
  input:focus,select:focus{outline:1px solid var(--acc)}
  button{cursor:pointer;background:var(--acc);border-color:var(--acc);color:#07101f;font-weight:600}
  button.ghost{background:var(--panel2);border-color:var(--line);color:var(--tx);font-weight:500}
  button.danger{background:var(--warn);border-color:var(--warn)}
  button.mini{padding:4px 8px;font-size:12px}
  button:disabled{opacity:.5;cursor:not-allowed}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
  th{color:var(--dim);font-weight:500;font-size:12px}
  .row{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
  .ok{color:var(--ok)}.warn{color:var(--warn)}.err{color:var(--err)}.dim{color:var(--dim)}
  .banner{padding:10px 12px;border-radius:8px;margin-bottom:12px;font-size:13px;border:1px solid}
  .banner.w{background:#3a2c12;border-color:#6b4f1c;color:#ffd899}
  .banner.e{background:#3a1a1a;border-color:#6b2a2a;color:#ffc4c4}
  .scroll{overflow-x:auto}
  #gate{position:fixed;inset:0;background:var(--bg);display:grid;place-items:center;z-index:9}
  #gate div{background:var(--panel);border:1px solid var(--line);padding:24px;border-radius:12px;width:min(380px,92vw)}
  .hide{display:none!important}
  .tabhide{display:none!important}
  td.del{width:1%}
  nav.tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:4px}
  nav.tabs button{background:var(--panel);border:1px solid var(--line);color:var(--dim);
                  font-weight:500;padding:8px 14px}
  nav.tabs button.on{background:var(--panel2);border-color:var(--acc);color:var(--tx);font-weight:600}
  #modal{position:fixed;inset:0;background:rgba(0,0,0,.6);display:grid;place-items:center;z-index:20}
  #modal .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;
               padding:20px;width:min(520px,94vw)}
  #modal h3{margin:0 0 6px;font-size:15px}
  #modal p.msg{color:var(--dim);font-size:13px;margin:0 0 8px;line-height:1.5}
  #modal .acts{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
  #modal .acts button{width:auto}
  nav.tabs button .badge{display:inline-block;background:var(--err);color:#fff;border-radius:9px;
                         padding:0 6px;font-size:11px;margin-left:6px}

  /* ───────────────────────── Celular ─────────────────────────
     O painel é feito de tabelas largas, que num telefone viram rolagem
     horizontal — a forma mais rápida de esconder justamente a coluna que
     importa. Abaixo de 720px cada linha vira um cartão, com o nome do campo
     ao lado do valor. Mesma informação, sem rolar de lado. */
  @media (max-width: 720px) {
    body{font-size:15px}
    main{padding:12px calc(12px + env(safe-area-inset-left)) calc(24px + env(safe-area-inset-bottom))}
    header{padding:12px calc(12px + env(safe-area-inset-left));
           padding-top:calc(12px + env(safe-area-inset-top))}
    section{padding:14px}
    button,input,select{min-height:44px}
    button.mini{min-height:34px}
    nav.tabs{overflow-x:auto;flex-wrap:nowrap;-webkit-overflow-scrolling:touch}
    nav.tabs button{white-space:nowrap;flex:0 0 auto}
    .grid{grid-template-columns:repeat(auto-fit,minmax(140px,1fr))}

    .scroll{overflow-x:visible}
    .scroll table, .scroll thead, .scroll tbody, .scroll th, .scroll td, .scroll tr{display:block}
    .scroll thead{position:absolute;left:-9999px}
    .scroll tr{background:var(--panel2);border:1px solid var(--line);border-radius:8px;
               padding:8px 10px;margin-bottom:10px}
    .scroll td{border:0;padding:4px 0;white-space:normal;display:flex;gap:10px;
               justify-content:space-between;align-items:baseline}
    .scroll td::before{content:attr(data-l);color:var(--dim);font-size:11px;
                       text-transform:uppercase;letter-spacing:.05em;flex:0 0 auto}
    .scroll td:empty{display:none}
    .row{flex-direction:column;align-items:stretch}
    .row>div,.row>button{width:100%}
  }
</style>
</head>
<body>
<div id="modal" class="hide"><div class="card">
  <h3 id="modalTitle">—</h3>
  <p class="msg" id="modalMsg"></p>
  <div id="modalFields"></div>
  <div class="acts">
    <button class="ghost" id="modalCancel">Cancelar</button>
    <button id="modalOk">Confirmar</button>
  </div>
</div></div>

<div id="gate"><div>
  <h1 style="margin-bottom:12px">Gateway — Admin</h1>
  <label>ADMIN_API_KEY</label>
  <!-- type=text de propósito: é um painel local, e um campo password invisível
       + autofill do navegador torna "chave errada" impossível de diagnosticar.
       name aleatório e autocomplete=off desencorajam o autopreenchimento. -->
  <input id="key" type="text" style="width:100%" class="mono" name="gw-admin-key-nofill"
         autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
         placeholder="admindev_…">
  <p class="dim" style="font-size:11px;margin:6px 0 0">Cole a linha inteira do .env se preferir — o prefixo <span class="mono">ADMIN_API_KEY=</span> é removido automaticamente.</p>
  <p id="gateErr" class="err hide" style="font-size:12px"></p>
  <button id="enter" style="width:100%;margin-top:12px">Entrar</button>
</div></div>

<header>
  <h1>Gateway — Admin</h1>
  <span id="envTag" class="dim mono"></span>
  <span style="flex:1"></span>
  <button class="ghost" id="refresh">Atualizar</button>
  <button class="ghost" id="logout">Sair</button>
</header>

<main>
  <nav class="tabs" id="tabbar">
    <button data-go="operacao" class="on">Operação</button>
    <button data-go="depositos">Depósitos</button>
    <button data-go="dinheiro">Dinheiro</button>
    <button data-go="socios">Sócios</button>
    <button data-go="lojas">Lojas</button>
    <button data-go="sistema">Sistema</button>
  </nav>

  <div id="warnings"></div>

  <section data-tab="operacao">
    <h2>Visão geral</h2>
    <div class="grid" id="kpis"></div>
  </section>

  <section id="orphanSection" class="hide" data-tab="operacao">
    <h2>Pagamentos sem ordem — dinheiro na conta sem destino</h2>
    <div class="scroll"><table id="orphanTable"><thead><tr>
      <th>Pagamento (MP)</th><th>Valor</th><th>Meio</th><th>Referência</th><th>Motivo</th>
    </tr></thead><tbody></tbody></table></div>
    <p class="dim" style="font-size:12px;margin-bottom:0">
      Todo pagamento aprovado na conta ou vira ordem, ou aparece aqui. "Intenção não confirmada"
      normalmente se resolve sozinho na próxima reconciliação; "sem referência" significa cobrança
      criada fora do gateway.
    </p>
    <div class="row" style="margin-top:10px"><button class="ghost" id="reconcileNow">Reconciliar agora</button></div>
  </section>

  <section data-tab="dinheiro">
    <h2>Taxas de gás</h2>
    <div id="gasOut" class="dim" style="font-size:13px;margin-bottom:10px">—</div>
    <div class="row"><button class="ghost" id="gasSweep">Varrer para a carteira de gás</button></div>
    <p class="dim" style="font-size:12px;margin-bottom:0">
      O custo de rede é cobrado do cliente e fica no vault, que é quem paga as taxas das próximas
      ordens. Só o excedente é varrido — a reserva de operação e o lucro ainda não distribuído
      nunca saem por aqui.
    </p>
  </section>

  <section data-tab="operacao">
    <h2>Fila de entrega — clientes pagos aguardando SOL</h2>
    <div id="pendingOut" class="dim" style="font-size:13px">—</div>
    <div class="scroll"><table id="pendTable"><thead><tr>
      <th>Desde</th><th>Pago</th><th>USDC necessário</th><th>Carteira do cliente</th><th>Estado</th>
    </tr></thead><tbody></tbody></table></div>
    <p class="dim" style="font-size:12px;margin-bottom:0">
      Estas ordens já receberam o dinheiro do cliente. Compre o USDC, envie para o vault, e elas
      concluem sozinhas na próxima varredura (a cada 5 minutos) — ou clique em "Retomar ordens".
    </p>
    <div class="row" style="margin-top:10px"><button class="ghost" id="retryNow">Retomar ordens agora</button></div>
  </section>

  <section data-tab="depositos">
    <h2>Depósitos — fila do provedor interno</h2>
    <div class="row" style="margin-bottom:10px">
      <button class="ghost" id="depScan">Varrer a chain agora</button>
      <a class="dim" href="/pay" target="_blank" rel="noopener" style="font-size:12px;align-self:center">abrir checkout &#8599;</a>
      <span style="flex:1"></span>
      <div><label>Filtro</label><select id="depFilter" style="width:190px">
        <option value="AWAITING_PAYMENT">aguardando pagamento</option>
        <option value="">todos</option>
        <option value="CONFIRMED">confirmados</option>
        <option value="EXPIRED">expirados</option>
        <option value="CANCELLED">cancelados</option>
      </select></div>
    </div>
    <div id="depScanOut" class="dim" style="font-size:12px;margin-bottom:8px"></div>
    <div class="scroll"><table id="depTable"><thead><tr>
      <th>Criada</th><th>Ref.</th><th>Trilho</th><th>Recebe</th><th>Retido</th><th>USDC</th>
      <th>Carteira</th><th>Estado</th><th>Ordem</th><th></th>
    </tr></thead><tbody></tbody></table></div>
    <p class="dim" style="font-size:12px;margin-bottom:0">
      Confirmar um trilho fiat é irreversível: a pipeline compra SOL com o USDC do vault e envia ao
      cliente. Confira o extrato antes. O trilho USDC confirma sozinho, pela varredura on-chain.
    </p>
  </section>

  <section data-tab="dinheiro">
    <h2>Divisão do dinheiro que entra</h2>
    <div class="row">
      <div><label>Fica em fiat (bps)</label><input id="rRetained" type="number" min="0" max="9000" style="width:130px"></div>
      <div><label>&nbsp;</label><div id="retainedPct" class="mono" style="padding:8px 0">—</div></div>
      <button id="saveRetained">Salvar divisão</button>
    </div>
    <p class="dim" style="font-size:12px;margin-bottom:0">
      Aplica-se aos trilhos <b>fiat</b> (cartão, Pix, SEPA, MB Way, Revolut): esta fração fica na
      sua conta e só o resto é convertido em SOL para o cliente. 3000 bps = 30%. Nessas ordens a
      taxa on-chain é zero — a receita já foi tirada aqui, cobrar de novo no SOL seria cobrar duas
      vezes. O trilho USDC não tem retenção: nele a receita continua sendo a taxa on-chain.
    </p>
  </section>

  <section data-tab="dinheiro">
    <h2>Câmbio do operador (depósitos fiat)</h2>
    <div class="row">
      <div><label>USDC por 1 EUR</label><input id="rEUR" type="number" step="0.0001" min="0" style="width:130px"></div>
      <div><label>USDC por 1 BRL</label><input id="rBRL" type="number" step="0.0001" min="0" style="width:130px"></div>
      <div><label>USDC por 1 USD</label><input id="rUSD" type="number" step="0.0001" min="0" style="width:130px"></div>
      <button id="saveRates">Salvar câmbio</button>
    </div>
    <p class="dim" style="font-size:12px;margin-bottom:0">
      Quanto USDC do float do vault cada unidade recebida vale. Não é cotação de mercado: é o câmbio
      que você consegue no banco. Com 1.0 em tudo, 10 EUR viram uma ordem de 10 USDC.
    </p>
  </section>

  <section data-tab="socios">
    <h2>Horário da distribuição de lucro</h2>
    <div class="row">
      <div><label>Ativa</label><select id="sEnabled"><option value="true">sim</option><option value="false">não</option></select></div>
      <div><label>Hora</label><input id="sHour" type="number" min="0" max="23" style="width:80px"></div>
      <div><label>Minuto</label><input id="sMin" type="number" min="0" max="59" style="width:80px"></div>
      <div><label>Timezone (IANA)</label><input id="sTz" style="width:200px" placeholder="Europe/Lisbon"></div>
      <div><label>Lucro mínimo (SOL)</label><input id="sMinProfit" type="number" step="0.001" min="0" style="width:130px"></div>
      <button id="saveSchedule">Salvar</button>
    </div>
    <p class="dim" style="font-size:12px;margin-bottom:0">Próxima execução: <span id="nextRun" class="mono">—</span></p>
  </section>

  <section data-tab="dinheiro">
    <h2>Taxa cobrada ao cliente</h2>
    <div class="row">
      <div><label>Margem (bps)</label><input id="fMargin" type="number" min="0" max="10000" style="width:110px"></div>
      <div><label>Piso (bps)</label><input id="fMin" type="number" min="0" max="10000" style="width:110px"></div>
      <div><label>Teto (bps)</label><input id="fMax" type="number" min="0" max="10000" style="width:110px"></div>
      <div><label>Custo fallback (bps)</label><input id="fFallback" type="number" min="0" max="10000" style="width:130px"></div>
      <button id="saveFees">Salvar</button>
    </div>
    <p class="dim" style="font-size:12px">100 bps = 1%. Taxa efetiva = custo do melhor provedor + margem, limitada por piso/teto.</p>
  </section>

  <section data-tab="socios">
    <h2>Carteiras do split (lucro)</h2>
    <div class="scroll">
      <table id="recTable">
        <thead><tr><th>Label</th><th>Endereço</th><th>bps</th><th>%</th><th></th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
    <div class="row" style="margin-top:10px">
      <button class="ghost" id="addRec">+ carteira</button>
      <span id="bpsSum" class="mono dim"></span>
      <span style="flex:1"></span>
      <button id="saveRecs">Salvar split</button>
    </div>
  </section>

  <section data-tab="lojas">
    <h2>Pedidos de integração — aguardando análise</h2>
    <div id="appOut" class="dim" style="font-size:13px;margin-bottom:10px">—</div>
    <div class="scroll"><table id="appTable"><thead><tr>
      <th>Quando</th><th>Empresa</th><th>Contato</th><th>Volume</th><th>Webhook</th>
      <th>O que faz</th><th>Estado</th><th></th>
    </tr></thead><tbody></tbody></table></div>
    <p class="dim" style="font-size:12px;margin-bottom:0">
      A chave de API só nasce na aprovação — e aparece uma única vez, aqui. O formulário público
      fica em <a href="/parceiros" target="_blank" rel="noopener">/parceiros</a>.
    </p>
  </section>

  <section data-tab="lojas">
    <h2>Lojas integradas — API</h2>
    <div class="row" style="margin-bottom:12px">
      <div><label>Nome da loja</label><input id="mName" style="width:180px" placeholder="Loja do Joao"></div>
      <div><label>E-mail</label><input id="mEmail" style="width:200px" placeholder="contato@loja.com"></div>
      <div><label>Webhook (https)</label><input id="mCallback" style="width:260px" placeholder="https://loja.com/webhooks/gateway"></div>
      <button id="mCreate">Criar loja</button>
    </div>

    <div class="box danger hide" id="mKeyBox" style="background:#3a2c12;border-color:#6b4f1c">
      <div class="k">Credenciais — copie agora, não aparecem de novo</div>
      <div class="v mono" style="word-break:break-all;margin-top:6px">
        <div>API key: <b id="mKeyValue">—</b></div>
        <div style="margin-top:4px">Webhook secret: <b id="mSecretValue">—</b></div>
      </div>
      <div class="row" style="margin-top:8px">
        <button class="ghost mini" data-copy="mKeyValue">Copiar chave</button>
        <button class="ghost mini" data-copy="mSecretValue">Copiar segredo</button>
      </div>
    </div>

    <div class="scroll"><table id="mTable"><thead><tr>
      <th>Loja</th><th>Chave</th><th>Webhook</th><th>Cobranças</th><th>Último uso</th><th>Estado</th><th></th>
    </tr></thead><tbody></tbody></table></div>

    <p class="dim" style="font-size:12px;margin-bottom:0">
      A chave é guardada como hash: um dump do banco não devolve acesso a nenhuma loja. Perdeu?
      Rotacione — a anterior deixa de valer no mesmo instante.
      Documentação para integrar: <a href="/docs" target="_blank" rel="noopener">/docs</a>
    </p>
  </section>

  <section data-tab="sistema">
    <h2>Taxas dos on-ramps em tempo real</h2>
    <div class="row">
      <div><label>Moeda</label><select id="qCur"><option>EUR</option><option>USD</option><option>BRL</option></select></div>
      <div><label>Valor</label><input id="qAmt" type="number" value="100" min="1" style="width:120px"></div>
      <button class="ghost" id="qGo">Consultar</button>
    </div>
    <div id="feeOut" style="margin-top:12px"></div>
  </section>

  <section data-tab="socios">
    <h2>Execuções de distribuição</h2>
    <div class="row" style="margin-bottom:10px">
      <button class="danger" id="runNow">Distribuir agora</button>
      <label style="margin:0;display:flex;gap:6px;align-items:center"><input type="checkbox" id="ignoreMin" style="width:auto"> ignorar mínimo</label>
    </div>
    <div class="scroll"><table id="runTable"><thead><tr><th>Quando</th><th>Trigger</th><th>Status</th><th>SOL</th><th>Ordens</th><th>Detalhe</th></tr></thead><tbody></tbody></table></div>
  </section>

  <section data-tab="operacao">
    <h2>Livro-razão — todas as ordens</h2>
    <div class="row" style="margin-bottom:10px">
      <div><label>Filtro</label><select id="ordFilter" style="width:190px">
        <option value="">todas</option>
        <option value="PENDING">aguardando entrega</option>
        <option value="SETTLED">entregues</option>
        <option value="DISTRIBUTED">finalizadas</option>
        <option value="FAILED">falhadas</option>
      </select></div>
      <div><label>Quantas</label><select id="ordLimit" style="width:100px">
        <option>25</option><option>50</option><option selected>100</option>
      </select></div>
      <span style="flex:1"></span>
      <label style="margin:0;display:flex;gap:6px;align-items:center">
        <input type="checkbox" id="autoRefresh" style="width:auto" checked> atualizar sozinho (30s)
      </label>
      <span class="dim mono" id="lastRefresh" style="font-size:11px;align-self:center"></span>
    </div>
    <div class="scroll"><table id="ordTable"><thead><tr>
      <th>Criada</th><th>Ref.</th><th>Cliente</th><th>Trilho</th><th>Pago</th><th>Retido</th>
      <th>Carteira de destino</th><th>SOL entregue</th><th>Status</th><th>Provas</th><th></th>
    </tr></thead><tbody></tbody></table></div>
    <p class="dim" style="font-size:12px;margin-bottom:0">
      "Carteira de destino" é para onde o SOL foi ou vai. Um cadeado indica carteira gerada por nós
      (a chave está no banco, cifrada); a chave aberta indica que o cliente já exportou a dele.
    </p>
  </section>
</main>

<script>
const $ = (id) => document.getElementById(id);
let KEY = sessionStorage.getItem('adminKey') || '';

async function api(path, options = {}) {
  const res = await fetch('/admin/api' + path, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'x-admin-key': KEY, ...(options.headers || {}) },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error((data && (data.message || data.error)) || ('HTTP ' + res.status));
  return data;
}

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function short(s) { return !s ? '—' : (s.length > 16 ? s.slice(0, 7) + '…' + s.slice(-5) : s); }
function fmt(n, d = 4) { return n == null ? '—' : Number(n).toFixed(d); }

// ── Gate ──
/** Aceita a chave crua, a linha inteira do .env, ou com aspas em volta. */
function normalizeKey(raw) {
  let v = String(raw || '').trim();
  v = v.replace(/^ADMIN_API_KEY\s*=\s*/i, '');
  v = v.replace(/^["']|["']$/g, '');
  return v.trim();
}

$('enter').onclick = async () => {
  KEY = normalizeKey($('key').value);
  if (!KEY) {
    $('gateErr').textContent = 'campo vazio';
    $('gateErr').classList.remove('hide');
    return;
  }
  try {
    await api('/overview');
    sessionStorage.setItem('adminKey', KEY);
    $('gate').classList.add('hide');
    loadAll();
    setAutoRefresh($('autoRefresh').checked);
  } catch (e) {
    $('gateErr').textContent = e.message;
    $('gateErr').classList.remove('hide');
  }
};
$('key').onkeydown = (e) => { if (e.key === 'Enter') $('enter').click(); };
$('logout').onclick = () => { sessionStorage.removeItem('adminKey'); location.reload(); };
$('refresh').onclick = () => loadAll();

// ── Diálogo ──
/**
 * Substitui 'prompt()'.
 *
 * O navegador embutido do app (Electron) não implementa 'prompt()' — ele lança
 * "prompt() is not supported" e mata o handler na primeira linha. Era por isso
 * que os botões de marcar entrega não faziam nada: o clique disparava e a
 * função morria antes de qualquer requisição.
 *
 * Resolve pedindo os campos numa caixa do próprio painel, que funciona em
 * qualquer navegador e ainda permite explicar o que cada campo significa.
 */
function ask(opts) {
  return new Promise((resolve) => {
    $('modalTitle').textContent = opts.title;
    $('modalMsg').innerHTML = opts.message || '';
    $('modalOk').textContent = opts.okLabel || 'Confirmar';
    $('modalOk').className = opts.danger ? 'danger' : '';

    const fields = opts.fields || [];
    $('modalFields').innerHTML = fields.map((f) =>
      f.type === 'checkbox'
        ? '<label style="display:flex;gap:8px;align-items:flex-start;margin-top:12px">' +
          '<input type="checkbox" id="f_' + f.name + '" style="width:auto;margin-top:3px">' +
          '<span style="font-size:13px">' + esc(f.label) + '</span></label>'
        : '<label>' + esc(f.label) + '</label>' +
          '<input id="f_' + f.name + '" class="mono" style="width:100%" ' +
          'placeholder="' + esc(f.placeholder || '') + '">'
    ).join('');

    $('modal').classList.remove('hide');
    const primeiro = $('modalFields').querySelector('input');
    if (primeiro) primeiro.focus();

    const fechar = (valor) => {
      $('modal').classList.add('hide');
      $('modalOk').onclick = null;
      $('modalCancel').onclick = null;
      resolve(valor);
    };

    $('modalCancel').onclick = () => fechar(null);
    $('modalOk').onclick = () => {
      const out = {};
      fields.forEach((f) => {
        const el = $('f_' + f.name);
        out[f.name] = f.type === 'checkbox' ? el.checked : el.value.trim();
      });
      fechar(out);
    };
  });
}

// ── Abas ──
/**
 * O painel cresceu por acréscimo: alertas, filas, precificação, sócios e
 * diagnóstico numa coluna só. Agrupar por TIPO DE TRABALHO — o que exige ação
 * hoje, o que é configuração, o que é conferência — é o que faz a tela do
 * dia a dia caber sem rolagem.
 *
 * A aba escolhida fica em sessionStorage: quem está acompanhando uma fila não
 * volta para o início a cada atualização automática.
 */
function showTab(tab) {
  document.querySelectorAll('main section[data-tab]').forEach((el) => {
    el.classList.toggle('tabhide', el.getAttribute('data-tab') !== tab);
  });
  document.querySelectorAll('#tabbar button').forEach((b) => {
    b.classList.toggle('on', b.getAttribute('data-go') === tab);
  });
  try { sessionStorage.setItem('adminTab', tab); } catch (e) { /* modo privado */ }
}

document.getElementById('tabbar').addEventListener('click', (ev) => {
  const tab = ev.target.getAttribute && ev.target.getAttribute('data-go');
  if (tab) showTab(tab);
});

/** Sinaliza nas abas o que precisa de atenção, sem precisar entrar nelas. */
function markTabs(d) {
  const pend = d.deposits.pendingDelivery.count;
  const orph = (d.orphanPayments || []).length;
  const badge = (n) => (n > 0 ? '<span class="badge">' + n + '</span>' : '');

  document.querySelector('#tabbar button[data-go="operacao"]').innerHTML =
    'Operação' + badge(pend + orph);
  // Intenção vencida não é fila: contá-la transforma o badge num número que
  // só cresce e ninguém mais olha.
  const lojas = document.querySelector('#tabbar button[data-go="lojas"]');
  if (lojas) lojas.innerHTML = 'Lojas' + badge(d.pendingApplications || 0);
  document.querySelector('#tabbar button[data-go="depositos"]').innerHTML =
    'Depósitos' + badge(d.deposits.awaitingActive);
}

// ── Overview ──
async function loadOverview() {
  const d = await api('/overview');
  $('envTag').textContent = d.env + ' · vault ' + short(d.vault.address);
  /**
   * Ordem deliberada: primeiro o que exige decisão hoje (gente esperando,
   * quanto comprar, se há lastro), depois o resultado (receita), e só então
   * os números que mudam devagar. Uma grade de KPI sem hierarquia é uma
   * parede de números onde o urgente some no meio.
   */
  $('kpis').innerHTML = [
    ['Aguardando entrega', d.deposits.pendingDelivery.count, 'clientes já pagaram'],
    ['USDC a comprar', fmt(d.deposits.pendingDelivery.usdcNeeded, 2), 'para zerar a fila'],
    ['Float USDC no vault', d.deposits.usdcFloat == null ? 'RPC off' : fmt(d.deposits.usdcFloat, 2), 'lastro disponível'],
    ['Fiat retido (receita)', (d.deposits.retainedFiat || []).map((r) => r.total + ' ' + r.currency).join(' · ') || '0', 'na conta do PSP/banco'],
    ['Depósitos aguardando', d.deposits.awaiting, d.deposits.methods.join(' · ')],
    ['Saldo do vault', d.vault.sol == null ? 'RPC off' : fmt(d.vault.sol) + ' SOL', 'gás para as transações'],
    ['Falhadas', d.orders.FAILED, 'exigem revisão'],
    ['Taxas de gás', fmt(d.gas.accruedSol, 6) + ' SOL', d.gas.wallet ? 'varrível: ' + fmt(d.gas.sweepableSol, 6) : 'sem carteira'],
    ['Lucro acumulado', fmt(d.profit.accruedSol) + ' SOL', d.profit.orderCount + ' ordens'],
    ['Liquidadas', d.orders.SETTLED, 'aguardando distribuição'],
    ['Distribuídas', d.orders.DISTRIBUTED, 'finalizadas'],
    ['Próxima distribuição', d.schedule.enabled ? new Date(d.schedule.nextRunAt).toLocaleString() : 'desativada', d.schedule.localTime + ' ' + d.schedule.timezone],
  ].map(([k, v, s]) => '<div class="kpi"><span>' + esc(k) + '</span><b>' + esc(v) + '</b><span>' + esc(s) + '</span></div>').join('');

  const w = [];
  if (d.warnings.partialRuns) w.push(['e', 'Existe execução PARCIAL de distribuição. Parte das transferências saiu. NÃO redistribua manualmente — inspecione as assinaturas antes.']);
  if (d.warnings.vaultBelowReserve) w.push(['w', 'Saldo do vault abaixo da reserva de fee: transações podem falhar.']);
  if (d.deposits.pendingDelivery.count > 0) {
    const p = d.deposits.pendingDelivery;
    const desde = p.oldestAt ? ' O mais antigo espera desde ' + new Date(p.oldestAt).toLocaleString() + '.' : '';
    w.push(['e', p.count + ' cliente(s) pagaram e ainda não receberam SOL. Compre ' +
      fmt(p.usdcNeeded, 2) + ' USDC e envie para o vault — as ordens concluem sozinhas depois disso.' + desde]);
  }
  if ((d.pendingApplications || 0) > 0) {
    w.push(['w', d.pendingApplications + ' loja(s) pedindo integração — veja a aba Lojas.']);
  }
  if ((d.orphanPayments || []).length > 0) {
    w.push(['e', d.orphanPayments.length + ' pagamento(s) aprovado(s) no Mercado Pago sem ordem ' +
      'correspondente. Dinheiro entrou na conta e o sistema não sabe de quem é — veja a tabela abaixo.']);
  }
  if (!d.deposits.requireFloat) {
    w.push(['w', 'Trava de float DESLIGADA: o gateway aceita depósitos que não consegue entregar na hora. ' +
      'É o modelo de conversão manual — acompanhe a fila de entrega.']);
  }
  $('warnings').innerHTML = w.map(([c, t]) => '<div class="banner ' + c + '">' + esc(t) + '</div>').join('');
  renderPending(d);
  renderGas(d);
  renderOrphans(d);
  markTabs(d);
}

// ── Settings ──
async function loadSettings() {
  const s = await api('/settings');
  $('sEnabled').value = String(s.distributionEnabled);
  $('sHour').value = s.distributionHour;
  $('sMin').value = s.distributionMinute;
  $('sTz').value = s.distributionTimezone;
  $('sMinProfit').value = (Number(s.minProfitLamports) / 1e9).toString();
  $('fMargin').value = s.marginBps;
  $('fMin').value = s.minFeeBps;
  $('fMax').value = s.maxFeeBps;
  $('fFallback').value = s.fallbackProviderCostBps;
  $('nextRun').textContent = new Date(s.nextRunAt).toLocaleString();
  $('rRetained').value = s.fiatRetainedBps;
  $('retainedPct').textContent = (s.fiatRetainedBps / 100).toFixed(2) + '% fica em fiat · ' +
    ((10000 - s.fiatRetainedBps) / 100).toFixed(2) + '% vira SOL';
  $('rEUR').value = s.depositRates.EUR;
  $('rBRL').value = s.depositRates.BRL;
  $('rUSD').value = s.depositRates.USD;
}

async function save(patch, btn) {
  btn.disabled = true;
  try { await api('/settings', { method: 'PUT', body: JSON.stringify(patch) }); await loadSettings(); await loadOverview(); }
  catch (e) { alert('Erro: ' + e.message); }
  finally { btn.disabled = false; }
}
$('saveSchedule').onclick = (e) => save({
  distributionEnabled: $('sEnabled').value === 'true',
  distributionHour: Number($('sHour').value),
  distributionMinute: Number($('sMin').value),
  distributionTimezone: $('sTz').value.trim(),
  minProfitLamports: String(Math.round(Number($('sMinProfit').value) * 1e9)),
}, e.target);
$('rRetained').oninput = () => {
  const bps = Number($('rRetained').value) || 0;
  $('retainedPct').textContent = (bps / 100).toFixed(2) + '% fica em fiat · ' +
    ((10000 - bps) / 100).toFixed(2) + '% vira SOL';
};
$('saveRetained').onclick = (e) => save({ fiatRetainedBps: Number($('rRetained').value) }, e.target);
$('saveRates').onclick = (e) => save({
  depositRates: {
    EUR: Number($('rEUR').value),
    BRL: Number($('rBRL').value),
    USD: Number($('rUSD').value),
  },
}, e.target);
$('saveFees').onclick = (e) => save({
  marginBps: Number($('fMargin').value),
  minFeeBps: Number($('fMin').value),
  maxFeeBps: Number($('fMax').value),
  fallbackProviderCostBps: Number($('fFallback').value),
}, e.target);

// ── Recipients ──
function recRow(r = { label: '', address: '', bps: 0 }) {
  const tr = document.createElement('tr');
  tr.innerHTML = '<td><input class="rl" value="' + esc(r.label) + '" style="width:130px"></td>' +
    '<td><input class="ra mono" value="' + esc(r.address) + '" style="width:340px"></td>' +
    '<td><input class="rb" type="number" min="1" max="10000" value="' + esc(r.bps) + '" style="width:90px"></td>' +
    '<td class="rp dim mono">' + (r.bps / 100).toFixed(2) + '%</td>' +
    '<td class="del"><button class="ghost">×</button></td>';
  tr.querySelector('.rb').oninput = sumBps;
  tr.querySelector('button').onclick = () => { tr.remove(); sumBps(); };
  return tr;
}
function sumBps() {
  const rows = [...document.querySelectorAll('#recTable tbody tr')];
  let sum = 0;
  rows.forEach((tr) => {
    const bps = Number(tr.querySelector('.rb').value) || 0;
    sum += bps;
    tr.querySelector('.rp').textContent = (bps / 100).toFixed(2) + '%';
  });
  $('bpsSum').textContent = 'soma: ' + sum + ' bps (' + (sum / 100).toFixed(2) + '%)';
  $('bpsSum').className = 'mono ' + (sum === 10000 ? 'ok' : 'err');
  $('saveRecs').disabled = sum !== 10000;
}
async function loadRecipients() {
  const d = await api('/recipients');
  const tb = document.querySelector('#recTable tbody');
  tb.innerHTML = '';
  d.recipients.forEach((r) => tb.appendChild(recRow(r)));
  sumBps();
}
$('addRec').onclick = () => { document.querySelector('#recTable tbody').appendChild(recRow()); sumBps(); };
$('saveRecs').onclick = async (e) => {
  const recipients = [...document.querySelectorAll('#recTable tbody tr')].map((tr) => ({
    label: tr.querySelector('.rl').value.trim(),
    address: tr.querySelector('.ra').value.trim(),
    bps: Number(tr.querySelector('.rb').value),
  }));
  e.target.disabled = true;
  try { await api('/recipients', { method: 'PUT', body: JSON.stringify({ recipients }) }); await loadRecipients(); alert('Split salvo.'); }
  catch (err) { alert('Erro: ' + err.message); }
  finally { e.target.disabled = false; }
};

// ── Fees ──
$('qGo').onclick = async () => {
  $('feeOut').innerHTML = '<span class="dim">consultando…</span>';
  try {
    const d = await api('/fees?refresh=1&currency=' + $('qCur').value + '&amount=' + $('qAmt').value);
    const f = d.effectiveFee;
    const rows = d.comparison.quotes.map((q) => '<tr><td>' + esc(q.provider) + '</td><td>' +
      (q.available ? '<span class="ok">' + q.costBps + ' bps</span>' : '<span class="dim">indisponível</span>') +
      '</td><td class="dim">' + esc(q.error || (q.provider === (d.comparison.best && d.comparison.best.provider) ? 'MELHOR' : '')) + '</td></tr>').join('');
    const adapters = d.adapters.map((a) => esc(a.provider) + ': ' + (a.enabled ? 'on' : 'off') + (a.implemented ? '' : ' (não implementado)')).join(' · ');
    $('feeOut').innerHTML =
      '<div class="banner w">' + esc(d.note) + '</div>' +
      '<div class="grid"><div class="kpi"><span>Custo do provedor</span><b>' + f.providerCostBps + ' bps</b><span>' + esc(f.sourceProvider) + '</span></div>' +
      '<div class="kpi"><span>Margem</span><b>' + f.marginBps + ' bps</b><span>configurada</span></div>' +
      '<div class="kpi"><span>Taxa ao cliente</span><b>' + f.feeBps + ' bps</b><span>' + (f.feeBps / 100).toFixed(2) + '%' + (f.clamped ? ' (limitada)' : '') + '</span></div></div>' +
      '<table style="margin-top:12px"><thead><tr><th>Provedor</th><th>Custo</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<p class="dim" style="font-size:12px">Adapters: ' + adapters + '</p>';
  } catch (e) { $('feeOut').innerHTML = '<span class="err">' + esc(e.message) + '</span>'; }
};

// ── Runs ──
async function loadRuns() {
  const d = await api('/runs');
  document.querySelector('#runTable tbody').innerHTML = d.runs.map((r) => {
    const cls = r.status === 'COMPLETED' ? 'ok' : (r.status === 'SKIPPED' ? 'dim' : (r.status === 'PARTIAL' ? 'err' : 'warn'));
    return '<tr><td data-l="Quando" class="mono">' + new Date(r.createdAt).toLocaleString() + '</td><td data-l="Trigger" class="dim">' + esc(r.trigger) +
      '</td><td data-l="Status" class="' + cls + '">' + esc(r.status) + '</td><td data-l="SOL" class="mono">' + fmt(r.totalSol) + '</td><td data-l="Ordens">' + r.orderCount +
      '</td><td data-l="Detalhe" class="dim">' + esc(r.skipReason || r.lastError || '') + '</td></tr>';
  }).join('') || '<tr><td colspan="6" class="dim">nenhuma execução ainda</td></tr>';
}
$('runNow').onclick = async (e) => {
  if (!confirm('Disparar a distribuição do lucro acumulado agora?')) return;
  e.target.disabled = true;
  try {
    const s = await api('/distribution/run-now', { method: 'POST', body: JSON.stringify({ ignoreMinimum: $('ignoreMin').checked }) });
    alert('Status: ' + s.status + (s.skipReason ? '\n' + s.skipReason : '\nSOL: ' + (Number(s.totalLamports) / 1e9)));
    loadAll();
  } catch (err) { alert('Erro: ' + err.message); }
  finally { e.target.disabled = false; }
};

// ── Pagamentos sem ordem ──
const ORPHAN_PT = {
  'sem-referencia': 'cobrança criada fora do gateway',
  'referencia-desconhecida': 'referência não existe neste banco',
  'intencao-nao-confirmada': 'pago, mas a intenção não foi confirmada',
};

function renderOrphans(d) {
  const list = d.orphanPayments || [];
  // classList e não className: sobrescrever a classe apagaria o estado da aba
  // e a seção apareceria em todas.
  $('orphanSection').classList.toggle('hide', list.length === 0);
  document.querySelector('#orphanTable tbody').innerHTML = list.map((o) =>
    '<tr><td data-l="Pagamento" class="mono">' + esc(o.paymentId) +
    '</td><td data-l="Valor" class="mono warn">' + esc(o.amount) + ' ' + esc(o.currency || '') +
    '</td><td data-l="Meio">' + esc(o.method || '—') +
    '</td><td data-l="Referência" class="mono">' + esc(o.reference || '—') +
    '</td><td data-l="Motivo" class="dim">' + esc(ORPHAN_PT[o.reason] || o.reason) + '</td></tr>'
  ).join('');
}

$('reconcileNow').onclick = async (e) => {
  e.target.disabled = true;
  try {
    const r = await api('/deposits/reconcile', { method: 'POST' });
    alert(r.skipped ? 'Nada a fazer: ' + r.skipped
      : 'Consultadas: ' + r.checked + '\nConfirmadas agora: ' + r.confirmed.length +
        '\nAinda em aberto: ' + r.stillOpen);
    loadAll();
  } catch (err) { alert('Erro: ' + err.message); }
  finally { e.target.disabled = false; }
};

// ── Taxas de gás ──
const GAS_LIMIT_PT = {
  'nada': '',
  'reserva': ' (limitado: o vault precisa manter a reserva de operação)',
  'lucro-nao-distribuido': ' (limitado: há lucro de sócios ainda no vault)',
  'saldo': ' (limitado pelo saldo do vault)',
};

function renderGas(d) {
  const g = d.gas;
  $('gasOut').innerHTML = !g.wallet
    ? '<span class="warn">GAS_FEE_WALLET não configurada — as taxas ficam no vault.</span>'
    : 'Acumulado: <b>' + fmt(g.accruedSol, 6) + ' SOL</b> em ' + g.orderCount + ' ordem(ns) · ' +
      'varrível agora: <b class="ok">' + fmt(g.sweepableSol, 6) + ' SOL</b>' +
      esc(GAS_LIMIT_PT[g.limitedBy] || '') +
      '<br><span class="mono dim" style="font-size:11px">destino: ' + esc(g.wallet) + '</span>';
  $('gasSweep').disabled = !g.wallet || g.sweepableSol <= 0;
}

$('gasSweep').onclick = async (e) => {
  if (!confirm('Enviar as taxas de gás acumuladas para a carteira configurada?')) return;
  e.target.disabled = true;
  try {
    const r = await api('/gas/sweep', { method: 'POST' });
    alert(r.skipped ? 'Nada varrido: ' + r.skipped
      : 'Enviado: ' + r.sol + ' SOL de ' + r.orderCount + ' ordem(ns).\ntx: ' + r.signature);
    loadAll();
  } catch (err) { alert('Erro: ' + err.message); }
  finally { e.target.disabled = false; }
};

// ── Fila de entrega ──
function renderPending(d) {
  const p = d.deposits.pendingDelivery;
  $('pendingOut').innerHTML = p.count === 0
    ? '<span class="ok">Nenhum cliente esperando.</span>'
    : '<b>' + p.count + '</b> cliente(s) esperando · comprar <b class="warn">' + fmt(p.usdcNeeded, 2) +
      ' USDC</b> e enviar para o vault';

  document.querySelector('#pendTable tbody').innerHTML = p.orders.map((o) =>
    '<tr><td data-l="Desde" class="mono dim">' + new Date(o.waitingSince).toLocaleString() +
    '</td><td data-l="Pago" class="mono">' + esc(o.fiat) +
    '</td><td data-l="USDC necessário" class="mono warn">' + esc(o.usdcNeeded) +
    '</td><td data-l="Carteira" class="mono dim" title="' + esc(o.customerWallet) + '">' + esc(short(o.customerWallet)) +
    '</td><td data-l="Estado" class="dim">' + esc((o.lastError || '').slice(0, 70)) + '</td></tr>'
  ).join('') || '<tr><td colspan="5" class="dim">fila vazia</td></tr>';
}

$('retryNow').onclick = async (e) => {
  e.target.disabled = true;
  try {
    const r = await api('/orders/retry', { method: 'POST' });
    alert('Ordens retomadas: ' + r.processed + ' de ' + r.found +
      (r.budgetExhausted ? '\n(orçamento esgotado, o resto vai no próximo tick)' : ''));
    loadAll();
  } catch (err) { alert('Erro: ' + err.message); }
  finally { e.target.disabled = false; }
};

// ── Deposits ──
const DEP_CLS = { AWAITING_PAYMENT: 'warn', CONFIRMED: 'ok', EXPIRED: 'dim', CANCELLED: 'dim' };

async function loadDeposits() {
  const status = $('depFilter').value;
  const d = await api('/deposits?limit=40' + (status ? '&status=' + status : ''));

  document.querySelector('#depTable tbody').innerHTML = d.intents.map((i) => {
    const pend = i.status === 'AWAITING_PAYMENT' || i.status === 'EXPIRED';
    // O botão de confirmar só aparece onde faz sentido: intenção em aberto.
    // Um trilho USDC também pode ser confirmado à mão (a varredura falhou, ou
    // o cliente mandou valor diferente), e aí o operador cola a assinatura.
    const actions = pend
      ? '<button class="mini danger" data-confirm="' + esc(i.reference) + '" data-expired="' + (i.expired ? '1' : '') +
        '" data-method="' + esc(i.method) + '">confirmar</button> ' +
        '<button class="mini ghost" data-cancel="' + esc(i.reference) + '">x</button>'
      : '';
    const order = i.orderId
      ? '<span class="' + (i.orderStatus === 'FAILED' ? 'err' : (i.orderStatus === 'SETTLED' || i.orderStatus === 'DISTRIBUTED' ? 'ok' : 'warn')) + '">' + esc(i.orderStatus || '?') + '</span>'
      : '<span class="dim">—</span>';
    return '<tr><td data-l="Criada" class="mono dim">' + new Date(i.createdAt).toLocaleString() +
      '</td><td data-l="Ref." class="mono">' + esc(i.reference) +
      '</td><td data-l="Trilho">' + esc(i.method) +
      '</td><td data-l="Recebe" class="mono">' + esc(i.fiat) +
      '</td><td data-l="Retido" class="mono ok">' + esc(i.retainedFiat == null ? '—' : i.retainedFiat) +
      '</td><td data-l="USDC" class="mono">' + esc(i.expectedUsdc) +
      '</td><td data-l="Carteira" class="mono dim" title="' + esc(i.customerWallet) + '">' + esc(short(i.customerWallet)) +
      '</td><td data-l="Estado" class="' + (DEP_CLS[i.status] || '') + '">' + esc(i.status) +
      (i.expired && i.status === 'AWAITING_PAYMENT' ? ' <span class="dim">(vencida)</span>' : '') +
      '</td><td data-l="Ordem">' + order +
      '</td><td>' + actions + '</td></tr>';
  }).join('') || '<tr><td colspan="10" class="dim">nada aqui</td></tr>';
}

$('depFilter').onchange = () => loadDeposits();

$('depScan').onclick = async (e) => {
  e.target.disabled = true;
  $('depScanOut').textContent = 'varrendo…';
  try {
    const r = await api('/deposits/scan', { method: 'POST' });
    $('depScanOut').textContent = r.skipped
      ? 'ignorada: ' + r.skipped
      : ('txs inspecionadas: ' + r.scanned + ' · confirmadas: ' + r.confirmed.length +
         ' · ambíguas: ' + r.ambiguous.length + ' · sem intenção: ' + r.unmatched.length);
    await Promise.all([loadDeposits(), loadOrders(), loadOverview()]);
  } catch (err) { $('depScanOut').innerHTML = '<span class="err">' + esc(err.message) + '</span>'; }
  finally { e.target.disabled = false; }
};

document.addEventListener('click', async (ev) => {
  const t = ev.target;
  if (!t.getAttribute) return;

  const ref = t.getAttribute('data-confirm');
  if (ref) {
    const expired = t.getAttribute('data-expired') === '1';
    const usdc = t.getAttribute('data-method') === 'USDC';
    if (!confirm('Confirmar ' + ref + '?\n\nIsto envia SOL ao cliente usando o USDC do vault. ' +
                 'Só confirme se o dinheiro realmente entrou.' + (expired ? '\n\nA intenção está VENCIDA.' : ''))) return;
    // A assinatura só é pedida no trilho USDC, onde ela existe e é o que
    // impede a mesma transferência de lastrear duas ordens.
    let sig = '';
    if (usdc) {
      const dados = await ask({
        title: 'Confirmar depósito em USDC',
        message: 'Se você tem a assinatura da transferência, cole aqui — é ela que impede a mesma ' +
          'transferência de lastrear duas ordens.',
        okLabel: 'Confirmar depósito',
        danger: true,
        fields: [{ name: 'signature', label: 'Assinatura (opcional)', placeholder: '5wHu1q…' }],
      });
      if (dados === null) return;
      sig = dados.signature;
    }
    t.disabled = true;
    try {
      const r = await api('/deposits/' + encodeURIComponent(ref) + '/confirm', {
        method: 'POST',
        body: JSON.stringify({ force: expired, ...(sig ? { depositSignature: sig.trim() } : {}) }),
      });
      alert('Ordem ' + r.orderId + ' criada.' +
        (r.pipeline && r.pipeline.timedOut ? '\n\nA pipeline não terminou na janela da invocação — o cron retoma.' : ''));
      await Promise.all([loadDeposits(), loadOrders(), loadOverview()]);
    } catch (err) { alert('Erro: ' + err.message); t.disabled = false; }
    return;
  }

  const cancelRef = t.getAttribute('data-cancel');
  if (cancelRef) {
    if (!confirm('Cancelar ' + cancelRef + '?')) return;
    try { await api('/deposits/' + encodeURIComponent(cancelRef) + '/cancel', { method: 'POST', body: '{}' }); await loadDeposits(); }
    catch (err) { alert('Erro: ' + err.message); }
  }
});

// ── Pedidos de integração ──
const APP_ESTADO = {
  pendente: '<span class="warn">aguardando análise</span>',
  aprovado: '<span class="ok">aprovado</span>',
  recusado: '<span class="dim">recusado</span>',
};

async function loadApplications() {
  const d = await api('/applications');
  const lista = d.applications || [];
  const pendentes = lista.filter((a) => a.status === 'pendente').length;

  $('appOut').innerHTML = pendentes === 0
    ? '<span class="ok">Nenhum pedido aguardando.</span>'
    : '<b class="warn">' + pendentes + '</b> pedido(s) aguardando a sua análise';

  document.querySelector('#appTable tbody').innerHTML = lista.map((a) => {
    const acoes = a.status === 'pendente'
      ? '<button class="mini" data-approve="' + esc(a.id) + '">aprovar</button> ' +
        '<button class="mini ghost" data-reject="' + esc(a.id) + '">recusar</button>'
      : (a.reviewNote ? '<span class="dim" style="font-size:11px">' + esc(a.reviewNote.slice(0, 40)) + '</span>' : '');

    const contato = esc(a.email) +
      (a.phone ? '<br><span class="dim" style="font-size:11px">' + esc(a.phone) + '</span>' : '');

    const empresa = '<b>' + esc(a.companyName) + '</b>' +
      (a.taxId ? '<br><span class="dim mono" style="font-size:11px">' + esc(a.taxId) + '</span>' : '') +
      (a.website ? '<br><a style="font-size:11px" target="_blank" rel="noopener" href="' +
        esc(a.website) + '">site</a>' : '');

    return '<tr>' +
      '<td data-l="Quando" class="mono dim">' + new Date(a.createdAt).toLocaleString() + '</td>' +
      '<td data-l="Empresa">' + empresa + '</td>' +
      '<td data-l="Contato">' + contato + '</td>' +
      '<td data-l="Volume" class="dim">' + esc(a.expectedVolume || '—') + '</td>' +
      '<td data-l="Webhook" class="mono dim" style="max-width:180px;overflow:hidden;text-overflow:ellipsis">' +
        esc(a.callbackUrl || '—') + '</td>' +
      '<td data-l="O que faz" class="dim" style="max-width:220px;white-space:normal">' +
        esc((a.description || '—').slice(0, 140)) + '</td>' +
      '<td data-l="Estado">' + (APP_ESTADO[a.status] || esc(a.status)) + '</td>' +
      '<td data-l="" class="del">' + acoes + '</td>' +
      '</tr>';
  }).join('') || '<tr><td colspan="8" class="dim">nenhum pedido ainda</td></tr>';
}

document.addEventListener('click', async (ev) => {
  const t = ev.target;
  if (!t.getAttribute) return;

  const aprovarId = t.getAttribute('data-approve');
  if (aprovarId) {
    const dados = await ask({
      title: 'Aprovar e criar a loja',
      message: 'Isso cria a loja e emite a chave de API. A chave aparece <b>uma única vez</b> — ' +
        'copie e mande para o contato da empresa por um canal seguro.',
      okLabel: 'Aprovar e gerar chave',
      fields: [{ name: 'note', label: 'Observação (opcional)', placeholder: 'combinado por telefone, etc.' }],
    });
    if (dados === null) return;

    t.disabled = true;
    try {
      const r = await api('/applications/' + encodeURIComponent(aprovarId) + '/approve', {
        method: 'POST', body: JSON.stringify({ note: dados.note }),
      });
      mostrarCredenciais(r.apiKey, r.webhookSecret);
      showTab('lojas');
      loadAll();
    } catch (err) { alert('Erro: ' + err.message); t.disabled = false; }
    return;
  }

  const recusarId = t.getAttribute('data-reject');
  if (recusarId) {
    const dados = await ask({
      title: 'Recusar pedido',
      message: 'O motivo fica registrado no painel. Nenhuma chave é emitida.',
      okLabel: 'Recusar',
      danger: true,
      fields: [{ name: 'note', label: 'Motivo', placeholder: 'fora do perfil, dados insuficientes…' }],
    });
    if (dados === null) return;
    try {
      await api('/applications/' + encodeURIComponent(recusarId) + '/reject', {
        method: 'POST', body: JSON.stringify({ note: dados.note }),
      });
      loadAll();
    } catch (err) { alert('Erro: ' + err.message); }
  }
});

// ── Lojas ──
async function loadMerchants() {
  const d = await api('/merchants');
  document.querySelector('#mTable tbody').innerHTML = d.merchants.map((m) =>
    '<tr>' +
    '<td data-l="Loja"><b>' + esc(m.name) + '</b><br><span class="dim" style="font-size:11px">' + esc(m.email) + '</span></td>' +
    '<td data-l="Chave" class="mono dim">' + esc(m.apiKeyPrefix) + '…</td>' +
    '<td data-l="Webhook" class="mono dim" style="max-width:220px;overflow:hidden;text-overflow:ellipsis">' +
      esc(m.callbackUrl || '—') + '</td>' +
    '<td data-l="Cobranças" class="mono">' + m.charges + '</td>' +
    '<td data-l="Último uso" class="mono dim">' + (m.lastUsedAt ? new Date(m.lastUsedAt).toLocaleString() : 'nunca') + '</td>' +
    '<td data-l="Estado" class="' + (m.active ? 'ok' : 'dim') + '">' + (m.active ? 'ativa' : 'desativada') + '</td>' +
    '<td data-l="" class="del">' +
      '<button class="mini ghost" data-rotate="' + esc(m.id) + '">nova chave</button> ' +
      '<button class="mini ghost" data-toggle="' + esc(m.id) + '" data-active="' + (m.active ? '1' : '') + '">' +
      (m.active ? 'desativar' : 'ativar') + '</button>' +
    '</td></tr>'
  ).join('') || '<tr><td colspan="7" class="dim">nenhuma loja ainda</td></tr>';
}

function mostrarCredenciais(apiKey, secret) {
  $('mKeyBox').classList.remove('hide');
  $('mKeyValue').textContent = apiKey;
  $('mSecretValue').textContent = secret || $('mSecretValue').textContent;
}

$('mCreate').onclick = async (e) => {
  e.target.disabled = true;
  try {
    const r = await api('/merchants', {
      method: 'POST',
      body: JSON.stringify({
        name: $('mName').value.trim(),
        email: $('mEmail').value.trim(),
        callbackUrl: $('mCallback').value.trim() || undefined,
      }),
    });
    mostrarCredenciais(r.apiKey, r.webhookSecret);
    $('mName').value = ''; $('mEmail').value = ''; $('mCallback').value = '';
    loadMerchants();
  } catch (err) { alert('Erro: ' + err.message); }
  finally { e.target.disabled = false; }
};

document.addEventListener('click', async (ev) => {
  const t = ev.target;
  if (!t.getAttribute) return;

  const rotateId = t.getAttribute('data-rotate');
  if (rotateId) {
    if (!confirm('Gerar uma chave nova?\n\nA chave atual para de funcionar imediatamente — a loja ' +
                 'precisa trocar antes da próxima cobrança.')) return;
    try {
      const r = await api('/merchants/' + encodeURIComponent(rotateId) + '/rotate', { method: 'POST' });
      mostrarCredenciais(r.apiKey, null);
      loadMerchants();
    } catch (err) { alert('Erro: ' + err.message); }
    return;
  }

  const toggleId = t.getAttribute('data-toggle');
  if (toggleId) {
    const ativa = t.getAttribute('data-active') === '1';
    try {
      await api('/merchants/' + encodeURIComponent(toggleId) + '/active', {
        method: 'POST', body: JSON.stringify({ active: !ativa }),
      });
      loadMerchants();
    } catch (err) { alert('Erro: ' + err.message); }
  }
});

// ── Livro-razão ──
function solscan(sig, label) {
  return sig
    ? '<a class="mono" style="font-size:11px" target="_blank" rel="noopener" href="https://solscan.io/tx/' +
      encodeURIComponent(sig) + '">' + label + '</a>'
    : '';
}

async function loadOrders() {
  const status = $('ordFilter').value;
  const limit = $('ordLimit').value;
  const d = await api('/orders?limit=' + limit + (status ? '&status=' + status : ''));

  document.querySelector('#ordTable tbody').innerHTML = d.orders.map((o) => {
    const cls = o.status === 'DISTRIBUTED' || o.status === 'SETTLED' ? 'ok'
      : (o.status === 'FAILED' ? 'err' : 'warn');
    // Espera por lastro é estado normal do modelo manual, não erro.
    const waiting = (o.lastError || '').indexOf('AGUARDANDO_LASTRO') === 0;
    const label = waiting
      ? 'AGUARDANDO ENTREGA'
      : o.status + (o.manualSettlement ? ' (manual)' : '');

    const custody = o.custodial
      ? (o.keyExported ? '<span class="dim" title="cliente já exportou a chave">&#128275;</span>'
                       : '<span class="dim" title="carteira custodiada por nós">&#128274;</span>')
      : '<span class="dim" title="carteira do próprio cliente">&#8599;</span>';

    // Só faz sentido marcar entrega no que ainda não foi entregue.
    const aberta = o.status === 'PENDING' || o.status === 'PROCESSING' || o.status === 'FAILED';
    const acao = aberta
      ? (o.status === 'FAILED'
          ? '<button class="mini ghost" data-reopen="' + esc(o.id) + '">reabrir</button> ' +
            '<button class="mini danger" data-settle="' + esc(o.id) + '">marcar entregue</button>'
          : '<button class="mini danger" data-settle="' + esc(o.id) + '">marcar entregue</button>')
      : (o.manualSettlement
          ? '<button class="mini ghost" data-undo="' + esc(o.id) + '" title="' +
            esc(o.settlementNote || 'registrado manualmente') + '">desfazer</button>'
          : '');

    const provas = [
      solscan(o.swapSignature, 'swap'),
      solscan(o.customerPayoutSignature, 'entrega'),
      o.pspPaymentId ? '<span class="dim mono" style="font-size:11px" title="id no Mercado Pago">MP ' + esc(o.pspPaymentId) + '</span>' : '',
    ].filter(Boolean).join(' · ') || '<span class="dim">—</span>';

    return '<tr>' +
      '<td data-l="Criada" class="mono dim">' + new Date(o.createdAt).toLocaleString() + '</td>' +
      '<td data-l="Ref." class="mono">' + esc(o.reference || '—') + '</td>' +
      '<td data-l="Cliente" class="dim">' + esc(o.customerEmail || '—') + '</td>' +
      '<td data-l="Trilho">' + esc(o.method) + '</td>' +
      '<td data-l="Pago" class="mono">' + esc(o.fiat) + '</td>' +
      '<td data-l="Retido" class="mono ok">' + esc(o.retainedFiat == null ? '—' : o.retainedFiat) + '</td>' +
      '<td data-l="Carteira" class="mono" title="' + esc(o.customerWallet) + '">' + custody + ' ' +
        '<a target="_blank" rel="noopener" href="https://solscan.io/account/' +
        encodeURIComponent(o.customerWallet) + '">' + esc(short(o.customerWallet)) + '</a></td>' +
      '<td data-l="SOL entregue" class="mono">' + (o.customerSol == null ? '—' : fmt(o.customerSol, 6)) + '</td>' +
      '<td data-l="Status" class="' + cls + '">' + esc(label) +
        (o.lastError && !waiting ? '<br><span class="dim" style="font-size:11px">' + esc(o.lastError.slice(0, 50)) + '</span>' : '') + '</td>' +
      '<td data-l="Provas">' + provas + '</td>' +
      '<td data-l="" class="del">' + acao + '</td>' +
      '</tr>';
  }).join('') || '<tr><td colspan="11" class="dim">nenhuma ordem ainda</td></tr>';

  $('lastRefresh').textContent = 'atualizado ' + new Date().toLocaleTimeString();
}

/**
 * Marcar entrega manual.
 *
 * Pede a assinatura porque é ela que transforma o registro em fato
 * verificável: o servidor busca a transação na rede e confere que ela creditou
 * a carteira daquela ordem. Só depois de recusar a assinatura o operador pode
 * registrar sem prova — e aí o painel mostra isso.
 */
document.addEventListener('click', async (ev) => {
  const t = ev.target;
  if (!t.getAttribute) return;

  const settleId = t.getAttribute('data-settle');
  if (settleId) {
    const dados = await ask({
      title: 'Marcar entrega como feita',
      message: 'Cole a assinatura da transação que entregou o SOL. O servidor confere na rede: ' +
        'ela precisa existir, ter tido sucesso e ter creditado a carteira desta ordem.',
      okLabel: 'Registrar entrega',
      danger: true,
      fields: [
        { name: 'signature', label: 'Assinatura da transação', placeholder: '5wHu1q…' },
        { name: 'note', label: 'Observação (opcional)', placeholder: 'enviado pela exchange, etc.' },
        { name: 'withoutProof', type: 'checkbox',
          label: 'Não há transação para comprovar (saque de exchange, por exemplo). ' +
                 'A ordem fecha sem verificação e fica marcada como não verificada.' },
      ],
    });
    if (dados === null) return;

    if (!dados.signature && !dados.withoutProof) {
      alert('Informe a assinatura, ou marque que não há transação para comprovar.');
      return;
    }

    t.disabled = true;
    try {
      const r = await api('/orders/' + encodeURIComponent(settleId) + '/settle', {
        method: 'POST',
        body: JSON.stringify({
          signature: dados.signature,
          note: dados.note,
          withoutProof: !!dados.withoutProof,
        }),
      });
      alert(r.verified
        ? 'Confirmado na rede: ' + r.sol.toFixed(6) + ' SOL creditados em ' + r.customerWallet
        : 'Registrado sem prova on-chain.');
      loadAll();
    } catch (err) { alert('Erro: ' + err.message); t.disabled = false; }
    return;
  }

  const reopenId = t.getAttribute('data-reopen');
  if (reopenId) {
    if (!confirm('Reabrir esta ordem?\n\nEla volta para a fila e a pipeline tenta de novo ' +
                 'assim que houver lastro no vault.')) return;
    try {
      await api('/orders/' + encodeURIComponent(reopenId) + '/reopen', { method: 'POST' });
      loadAll();
    } catch (err) { alert('Erro: ' + err.message); }
    return;
  }

  const undoId = t.getAttribute('data-undo');
  if (undoId) {
    if (!confirm('Desfazer o registro manual? A ordem volta para a fila de entrega.')) return;
    try {
      await api('/orders/' + encodeURIComponent(undoId) + '/settle/undo', { method: 'POST' });
      loadAll();
    } catch (err) { alert('Erro: ' + err.message); }
  }
});

$('ordFilter').onchange = () => loadOrders();
$('ordLimit').onchange = () => loadOrders();

/**
 * Atualização automática.
 *
 * O painel é a única janela para o dinheiro em trânsito: deixá-lo aberto numa
 * tela e ele se manter atual é o que torna "controle 24 horas" verdadeiro em
 * vez de uma promessa que depende de alguém lembrar de apertar F5.
 */
let autoTimer = null;
function setAutoRefresh(on) {
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
  if (on) autoTimer = setInterval(() => { loadAll().catch(() => {}); }, 30000);
}
$('autoRefresh').onchange = (e) => setAutoRefresh(e.target.checked);

async function loadAll() {
  try { await Promise.all([loadOverview(), loadSettings(), loadDeposits(), loadRecipients(), loadRuns(), loadOrders(), loadMerchants(), loadApplications()]); }
  catch (e) {
    if (String(e.message).includes('unauthorized')) { sessionStorage.removeItem('adminKey'); location.reload(); }
    else console.error(e);
  }
}

let tabInicial = 'operacao';
try { tabInicial = sessionStorage.getItem('adminTab') || 'operacao'; } catch (e) { /* noop */ }
showTab(tabInicial);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/pwa/sw.js', { scope: '/admin' }).catch(() => {});
}

if (KEY) { $('gate').classList.add('hide'); loadAll(); }
setAutoRefresh($('autoRefresh').checked);
</script>
</body>
</html>`;
