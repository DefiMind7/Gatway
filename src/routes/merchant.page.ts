/**
 * Portal da loja — página única, embutida.
 *
 * Cobre a vida inteira da conta: criar, entrar, pedir análise, receber a
 * resposta, emitir a chave, faturar, sacar e trocar a senha. Uma página só
 * porque o estado é pequeno e o roteador de verdade é o estado da conta — quem
 * ainda não foi aprovado não tem o que ver na aba de integração, e mostrar a
 * aba vazia seria pior do que escondê-la.
 *
 * Cuidado ao editar: o corpo vive dentro de String.raw. Crase aqui encerra o
 * literal — todo JS desta página concatena com +, sem template literal.
 */
export const MERCHANT_PAGE_HTML = String.raw`<!doctype html>
<html lang="pt">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#0f1216">
<title>Minha loja</title>
<style>
  :root{--bg:#0f1216;--panel:#171b21;--panel2:#1e242c;--line:#2a323c;--tx:#e6eaef;--dim:#94a1b2;--ok:#3ddc97;--warn:#ffb84d;--err:#ff6b6b;--acc:#5b9dff}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--tx);
       font:15px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  main{max-width:800px;margin:0 auto;
       padding:calc(22px + env(safe-area-inset-top)) 16px calc(56px + env(safe-area-inset-bottom))}
  h1{font-size:20px;margin:0}
  section{background:var(--panel);border:1px solid var(--line);border-radius:12px;
          padding:18px;margin-bottom:14px}
  h2{font-size:12px;text-transform:uppercase;letter-spacing:.07em;color:var(--dim);margin:0 0 14px}
  h3{font-size:14px;margin:22px 0 0;font-weight:650}
  label{display:block;font-size:12px;color:var(--dim);margin:12px 0 5px}
  input,button,select,textarea{font:inherit;color:var(--tx);background:var(--panel2);
    border:1px solid var(--line);border-radius:8px;padding:11px 12px;width:100%;min-height:44px}
  textarea{min-height:84px;resize:vertical}
  input:focus,select:focus,textarea:focus{outline:1px solid var(--acc)}
  input:disabled{color:var(--dim)}
  button{cursor:pointer;background:var(--acc);border-color:var(--acc);color:#07101f;
         font-weight:650;margin-top:16px}
  button.ghost{background:var(--panel2);border-color:var(--line);color:var(--tx);font-weight:500}
  button.danger{background:var(--panel2);border-color:#6b2a2a;color:#ffc4c4;font-weight:500}
  button.mini{width:auto;padding:6px 10px;font-size:12px;min-height:34px;margin:0}
  button:disabled{opacity:.5;cursor:not-allowed}
  .topo{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:14px}
  .topo .quem{font-size:12px;color:var(--dim)}
  .abas{display:flex;gap:6px;overflow-x:auto;margin-bottom:14px;padding-bottom:2px}
  /* width:auto anula o 100% herdado do reset de formulário — sem isto cada
     aba ocupa a linha inteira e a barra vira uma coluna com rolagem. */
  .abas button{margin:0;flex:0 0 auto;width:auto;background:var(--panel);border-color:var(--line);
               color:var(--dim);font-weight:500;padding:9px 14px;min-height:38px;font-size:14px}
  .abas button.on{background:var(--acc);border-color:var(--acc);color:#07101f;font-weight:650}
  .abas .pino{display:inline-block;min-width:18px;padding:0 5px;margin-left:6px;border-radius:9px;
              background:var(--err);color:#fff;font-size:11px;line-height:18px;text-align:center}
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
  .banner.a{background:#33280f;border-color:#6b5522;color:#ffdfa8}
  .estado{border-radius:12px;border:1px solid;padding:18px;margin-bottom:14px}
  .estado b{display:block;font-size:16px;margin-bottom:4px}
  .estado.esperando{background:#221c0c;border-color:#5c4a1c;color:#ffdfa8}
  .estado.aprovada{background:#0f2a24;border-color:#1f5f4f;color:#b6f0dc}
  .estado.recusada{background:#2c1618;border-color:#6b2a2a;color:#ffc4c4}
  .estado.nova{background:var(--panel2);border-color:var(--line);color:var(--tx)}
  .avisos{list-style:none;margin:0;padding:0}
  .avisos li{display:flex;gap:11px;padding:11px 0;border-bottom:1px solid var(--line)}
  .avisos li:last-child{border-bottom:0}
  .avisos .ponto{flex:0 0 8px;height:8px;border-radius:50%;margin-top:7px;background:transparent}
  .avisos li.novo .ponto{background:var(--acc)}
  .avisos .t{font-weight:650;font-size:14px}
  .avisos .c{color:var(--dim);font-size:13px}
  .avisos .q{color:var(--dim);font-size:11px;margin-top:2px}
  .segredo{background:var(--panel2);border:1px solid var(--line);border-radius:8px;
           padding:12px;margin-top:10px}
  .linha{display:flex;gap:12px;flex-wrap:wrap}
  .linha>div{flex:1;min-width:200px}
  .hide{display:none!important}
  .scroll{overflow-x:auto}
  a{color:var(--acc)}
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
    <div>
      <h1>Minha loja</h1>
      <div class="quem hide" id="quem">—</div>
    </div>
    <button class="ghost mini hide" id="sair">Sair</button>
  </div>

  <div id="alert" class="banner e hide"></div>

  <!-- ═══════════ Entrada ═══════════ -->
  <div id="porta">
    <div class="abas">
      <button class="on" data-porta="entrar">Entrar</button>
      <button data-porta="criar">Criar conta</button>
      <button data-porta="esqueci">Esqueci a senha</button>
    </div>

    <section data-p="entrar">
      <h2>Entrar</h2>
      <label for="email">E-mail</label>
      <input id="email" type="email" autocomplete="username" placeholder="contato@sualoja.com">
      <label for="password">Senha</label>
      <input id="password" type="password" autocomplete="current-password">
      <button id="entrar">Entrar</button>
    </section>

    <section data-p="criar" class="hide">
      <h2>Criar conta</h2>
      <p class="dim" style="font-size:13px;margin:0 0 4px">
        A conta é grátis e imediata. Cobrar de verdade depende da análise, que você
        pede aqui dentro logo depois.
      </p>
      <label for="cEmpresa">Nome da sua loja</label>
      <input id="cEmpresa" placeholder="Como a sua loja é conhecida" maxlength="120">
      <label for="cEmail">E-mail</label>
      <input id="cEmail" type="email" autocomplete="username" placeholder="contato@sualoja.com">
      <label for="cSenha">Senha</label>
      <input id="cSenha" type="password" autocomplete="new-password" placeholder="mínimo de 10 caracteres">
      <label for="cSenha2">Repita a senha</label>
      <input id="cSenha2" type="password" autocomplete="new-password">
      <button id="criar">Criar conta</button>
    </section>

    <section data-p="esqueci" class="hide">
      <h2>Recuperar acesso</h2>
      <p class="dim" style="font-size:13px;margin:0 0 4px">
        Não mandamos e-mail: o seu pedido entra na fila do nosso operador, que confirma
        quem você é e emite uma senha temporária. Tenha o telefone do cadastro à mão.
      </p>
      <label for="fEmail">E-mail da conta</label>
      <input id="fEmail" type="email" placeholder="contato@sualoja.com">
      <button id="pedirSenha">Pedir recuperação</button>
    </section>
  </div>

  <!-- ═══════════ Senha temporária: única porta aberta ═══════════ -->
  <div id="forcado" class="hide">
    <div class="banner a">
      Você entrou com uma senha temporária. Escolha uma senha sua para liberar o painel.
    </div>
    <section>
      <h2>Definir a sua senha</h2>
      <label for="tAtual">Senha temporária</label>
      <input id="tAtual" type="password" autocomplete="current-password">
      <label for="tNova">Nova senha</label>
      <input id="tNova" type="password" autocomplete="new-password" placeholder="mínimo de 10 caracteres">
      <label for="tNova2">Repita a nova senha</label>
      <input id="tNova2" type="password" autocomplete="new-password">
      <button id="trocarForcado">Salvar e entrar</button>
    </section>
  </div>

  <!-- ═══════════ Painel ═══════════ -->
  <div id="painel" class="hide">
    <div class="abas" id="abas">
      <button class="on" data-aba="inicio">Início<span class="pino hide" id="pinoAvisos">0</span></button>
      <button data-aba="pedido">Pedido</button>
      <button data-aba="vendas">Vendas</button>
      <button data-aba="saques">Saques</button>
      <button data-aba="integracao">Integração</button>
      <button data-aba="config">Configurações</button>
    </div>

    <!-- ── Início ── -->
    <div data-a="inicio">
      <div id="estado" class="estado nova"><b>—</b><span></span></div>

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
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
          <h2 style="margin:0">Avisos</h2>
          <button class="ghost mini" id="lerTudo">Marcar tudo como lido</button>
        </div>
        <ul class="avisos" id="listaAvisos" style="margin-top:12px"></ul>
      </section>
    </div>

    <!-- ── Pedido de análise ── -->
    <div data-a="pedido" class="hide">
      <section>
        <h2>Pedido de integração</h2>
        <div id="pedidoFeito" class="hide"></div>

        <div id="pedidoForm">
          <p class="dim" style="font-size:13px;margin:0 0 4px">
            Conte quem é a sua empresa. A resposta aparece aqui no painel — não vai por e-mail.
          </p>

          <label for="pEmpresa">Nome da empresa</label>
          <input id="pEmpresa" maxlength="120" placeholder="Como a sua loja é conhecida">

          <div class="linha">
            <div>
              <label for="pRazao">Razão social</label>
              <input id="pRazao" maxlength="160" placeholder="Nome registrado">
            </div>
            <div>
              <label for="pCnpj">CNPJ</label>
              <input id="pCnpj" maxlength="20" placeholder="00.000.000/0001-00">
            </div>
          </div>

          <div class="linha">
            <div>
              <label for="pTelefone">Telefone</label>
              <input id="pTelefone" maxlength="30" placeholder="(11) 90000-0000">
            </div>
            <div>
              <label for="pSite">Site</label>
              <input id="pSite" maxlength="200" placeholder="https://sualoja.com">
            </div>
          </div>

          <label for="pVolume">Volume esperado por mês</label>
          <select id="pVolume"><option value="">prefiro não informar</option></select>

          <label for="pWebhook">URL de webhook (opcional)</label>
          <input id="pWebhook" maxlength="300" placeholder="https://sualoja.com/webhooks/gateway">
          <p class="dim" style="font-size:11px;margin:5px 0 0">
            É para lá que avisamos quando um pedido é pago. Dá para configurar depois.
          </p>

          <label for="pDescricao">O que você vende</label>
          <textarea id="pDescricao" maxlength="2000" placeholder="Produtos, público, como funciona hoje"></textarea>

          <button id="enviarPedido">Enviar para análise</button>
        </div>
      </section>
    </div>

    <!-- ── Vendas ── -->
    <div data-a="vendas" class="hide">
      <section>
        <h2>Vendas recentes</h2>
        <div class="scroll"><table id="tabelaVendas"><thead><tr>
          <th>Quando</th><th>Referência</th><th>Pedido</th><th>Valor</th><th>Estado</th>
        </tr></thead><tbody></tbody></table></div>
      </section>
    </div>

    <!-- ── Saques ── -->
    <div data-a="saques" class="hide">
      <section>
        <h2>Sacar</h2>

        <label for="metodo">Como você quer receber</label>
        <select id="metodo">
          <option value="SOL">Cripto — SOL na sua carteira</option>
          <option value="FIAT">Dinheiro — transferência bancária</option>
        </select>

        <div id="blocoSol">
          <label for="wallet">Sua carteira Solana</label>
          <input id="wallet" class="mono" placeholder="Cole o endereço que vai receber" spellcheck="false">
        </div>

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
        <h2>Histórico de saques</h2>
        <div class="scroll"><table id="tabelaSaques"><thead><tr>
          <th>Quando</th><th>Valor</th><th>Forma</th><th>Estado</th><th>Comprovante</th>
        </tr></thead><tbody></tbody></table></div>
      </section>
    </div>

    <!-- ── Integração ── -->
    <div data-a="integracao" class="hide">
      <div id="integracaoBloqueada" class="banner a hide">
        A chave de API é liberada quando o seu pedido for aprovado.
      </div>

      <section id="integracaoBox">
        <h2>Chave de API</h2>
        <p class="dim" style="font-size:13px;margin:0">
          Ela vai no cabeçalho <span class="mono">Authorization: Bearer …</span> das chamadas do
          servidor da sua loja. Guardamos só o resumo criptográfico dela — se perder, emita outra.
        </p>

        <div class="segredo">
          <div class="dim" style="font-size:11px;text-transform:uppercase;letter-spacing:.06em">Chave atual</div>
          <div class="mono" id="chaveAtual" style="margin-top:4px">—</div>
        </div>

        <div class="segredo hide" id="chaveNovaBox" style="border-color:#1f5f4f;background:#0f2a24">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#b6f0dc">
            Copie agora — não aparece de novo
          </div>
          <div class="mono" id="chaveNova" style="margin-top:6px;color:#dcfff2"></div>
          <button class="ghost mini" id="copiarChave" style="margin-top:10px">Copiar</button>
        </div>

        <button id="emitirChave">Emitir chave</button>

        <h3>Segredo de webhook</h3>
        <p class="dim" style="font-size:13px;margin:4px 0 0">
          Com ele a sua loja confere que a notificação de pagamento veio mesmo de nós,
          e não de alguém fingindo ser.
        </p>
        <div class="segredo">
          <div class="mono" id="segredoWebhook">••••••••••••</div>
          <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
            <button class="ghost mini" id="verSegredo">Mostrar</button>
            <button class="ghost mini" id="trocarSegredo">Trocar segredo</button>
          </div>
        </div>

        <h3>URLs</h3>
        <label for="iCallback">Webhook — para onde avisamos o pagamento</label>
        <input id="iCallback" maxlength="300" placeholder="https://sualoja.com/webhooks/gateway">
        <label for="iReturn">Retorno — para onde o cliente volta depois de pagar</label>
        <input id="iReturn" maxlength="300" placeholder="https://sualoja.com/pedido/obrigado">
        <p class="dim" style="font-size:11px;margin:5px 0 0">
          As duas precisam ser https públicas.
        </p>
        <button class="ghost" id="salvarUrls">Salvar URLs</button>

        <h3>Como integrar</h3>
        <p class="dim" style="font-size:13px;margin:4px 0 0">
          O passo a passo, com exemplos de chamada, está na
          <a href="/docs" target="_blank" rel="noopener">documentação da API</a>.
        </p>
      </section>
    </div>

    <!-- ── Configurações ── -->
    <div data-a="config" class="hide">
      <section>
        <h2>Dados da empresa</h2>
        <label for="gEmpresa">Nome da loja</label>
        <input id="gEmpresa" maxlength="120">
        <div class="linha">
          <div><label for="gRazao">Razão social</label><input id="gRazao" maxlength="160"></div>
          <div><label for="gCnpj">CNPJ</label><input id="gCnpj" maxlength="20"></div>
        </div>
        <div class="linha">
          <div><label for="gTelefone">Telefone</label><input id="gTelefone" maxlength="30"></div>
          <div><label for="gSite">Site</label><input id="gSite" maxlength="200" placeholder="https://…"></div>
        </div>
        <label for="gEmailFixo">E-mail de acesso</label>
        <input id="gEmailFixo" disabled>
        <p class="dim" style="font-size:11px;margin:5px 0 0">
          O e-mail é a identidade da conta e não muda por aqui — peça ao suporte.
        </p>
        <button class="ghost" id="salvarPerfil">Salvar dados</button>
      </section>

      <section>
        <h2>Senha</h2>
        <label for="sAtual">Senha atual</label>
        <input id="sAtual" type="password" autocomplete="current-password">
        <label for="sNova">Nova senha</label>
        <input id="sNova" type="password" autocomplete="new-password" placeholder="mínimo de 10 caracteres">
        <label for="sNova2">Repita a nova senha</label>
        <input id="sNova2" type="password" autocomplete="new-password">
        <p class="dim" style="font-size:11px;margin:8px 0 0">
          Trocar a senha encerra as outras sessões abertas.
        </p>
        <button id="trocarSenha">Trocar senha</button>
      </section>

      <section>
        <h2>Dispositivos conectados</h2>
        <div class="scroll"><table id="tabelaSessoes"><thead><tr>
          <th>Entrou em</th><th>De onde</th><th>Vale até</th><th></th>
        </tr></thead><tbody></tbody></table></div>
        <button class="danger" id="encerrarSessoes">Encerrar as outras sessões</button>
      </section>

      <section>
        <h2>Conta</h2>
        <p class="dim" style="font-size:13px;margin:0" id="resumoConta">—</p>
      </section>
    </div>
  </div>

  <footer style="text-align:center;color:var(--dim);font-size:12px;margin-top:26px">
    <a href="/">Início</a> · <a href="/docs">Documentação</a>
  </footer>
</main>

<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var CHAVE_SESSAO = 'gw:merchant';
  var sessao = null;
  var dadosAtuais = null;
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
  var quando = function (iso) { return iso ? new Date(iso).toLocaleString() : '—'; };

  // ═══════════ Navegação ═══════════

  document.querySelector('#porta .abas').addEventListener('click', function (e) {
    var alvo = e.target.getAttribute('data-porta');
    if (!alvo) return;
    alerta('');
    var botoes = document.querySelectorAll('#porta .abas button');
    for (var i = 0; i < botoes.length; i++) {
      botoes[i].className = botoes[i].getAttribute('data-porta') === alvo ? 'on' : '';
    }
    var secoes = document.querySelectorAll('#porta section');
    for (var j = 0; j < secoes.length; j++) {
      secoes[j].className = secoes[j].getAttribute('data-p') === alvo ? '' : 'hide';
    }
  });

  function abrirAba(nome) {
    var botoes = $('abas').querySelectorAll('button');
    for (var i = 0; i < botoes.length; i++) {
      botoes[i].className = botoes[i].getAttribute('data-aba') === nome ? 'on' : '';
    }
    var painels = $('painel').querySelectorAll('[data-a]');
    for (var j = 0; j < painels.length; j++) {
      painels[j].className = painels[j].getAttribute('data-a') === nome ? '' : 'hide';
    }
    if (nome === 'config') carregarSessoes();
    window.scrollTo({ top: 0 });
  }

  $('abas').addEventListener('click', function (e) {
    var alvo = e.target.getAttribute('data-aba');
    if (alvo) { alerta(''); abrirAba(alvo); }
  });

  // ═══════════ Render ═══════════

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

  /**
   * O cartão de estado da conta.
   *
   * É a primeira coisa da tela porque é a primeira pergunta de quem entra:
   * "já posso cobrar?". Cada estado carrega a ação que faz sentido nele — e
   * só ela.
   */
  function pintarEstado(m, pedido) {
    var el = $('estado');
    if (m.status === 'aprovado') {
      el.className = 'estado aprovada';
      el.innerHTML = '<b>Sua loja está aprovada</b>' +
        '<span>Emita a sua chave de API e comece a cobrar.</span><br>' +
        '<button class="ghost mini" data-ir="integracao" style="margin-top:12px">Ir para Integração</button>';
    } else if (m.status === 'em_analise') {
      el.className = 'estado esperando';
      el.innerHTML = '<b>Pedido em análise</b>' +
        '<span>Enviado em ' + esc(quando(pedido && pedido.createdAt)) +
        '. A resposta aparece aqui e na lista de avisos.</span>';
    } else if (m.status === 'recusado') {
      el.className = 'estado recusada';
      el.innerHTML = '<b>Pedido não aprovado</b><span>' +
        esc((pedido && pedido.reviewNote) || 'Confira os dados da empresa e envie de novo.') +
        '</span><br><button class="ghost mini" data-ir="pedido" style="margin-top:12px">Enviar novo pedido</button>';
    } else {
      el.className = 'estado nova';
      el.innerHTML = '<b>Falta o pedido de análise</b>' +
        '<span>A sua conta existe, mas ainda não pode cobrar. Envie os dados da empresa.</span><br>' +
        '<button class="mini" data-ir="pedido" style="margin-top:12px">Pedir análise</button>';
    }
  }

  $('estado').addEventListener('click', function (e) {
    var ir = e.target.getAttribute('data-ir');
    if (ir) abrirAba(ir);
  });

  function pintarAvisos(lista, naoLidos) {
    $('listaAvisos').innerHTML = (lista || []).map(function (a) {
      return '<li class="' + (a.read ? '' : 'novo') + '">' +
        '<span class="ponto"></span><div>' +
        '<div class="t">' + esc(a.title) + '</div>' +
        (a.body ? '<div class="c">' + esc(a.body) + '</div>' : '') +
        '<div class="q">' + esc(quando(a.createdAt)) + '</div>' +
        '</div></li>';
    }).join('') || '<li class="dim">nenhum aviso ainda</li>';

    var pino = $('pinoAvisos');
    if (naoLidos > 0) { pino.textContent = naoLidos; pino.className = 'pino'; }
    else pino.className = 'pino hide';
  }

  function mostrar(dados) {
    dadosAtuais = dados;
    var m = dados.merchant;

    $('porta').classList.add('hide');
    $('sair').classList.remove('hide');
    $('quem').classList.remove('hide');
    $('quem').textContent = m.name + ' · ' + m.email;

    // Senha temporária: nada do painel abre antes da troca.
    if (m.mustChangePassword) {
      $('forcado').classList.remove('hide');
      $('painel').classList.add('hide');
      return;
    }
    $('forcado').classList.add('hide');
    $('painel').classList.remove('hide');

    pintarEstado(m, dados.application);
    pintarAvisos(dados.notifications, dados.unread);

    var b = dados.balance;
    $('saldo').textContent = brl(b.available);
    $('vendas').textContent = brl(b.totalSales);
    $('sacado').textContent = brl(b.totalWithdrawn);
    $('qtd').textContent = b.salesCount;
    $('comissao').textContent =
      'Comissão do gateway: ' + (m.commissionBps / 100).toFixed(2) +
      '% sobre cada venda. Já retido: ' + brl(b.totalCommission) + '.';

    // ── aba Pedido ──
    var jaPediu = m.status === 'em_analise' || m.status === 'aprovado';
    $('pedidoForm').className = jaPediu ? 'hide' : '';
    $('pedidoFeito').className = jaPediu ? '' : 'hide';
    if (jaPediu) {
      $('pedidoFeito').innerHTML = m.status === 'aprovado'
        ? '<div class="banner o" style="margin:0">Pedido aprovado em ' +
          esc(quando(dados.application && dados.application.reviewedAt)) + '.</div>'
        : '<div class="banner a" style="margin:0">Pedido enviado em ' +
          esc(quando(dados.application && dados.application.createdAt)) +
          '. Estamos analisando.</div>';
    } else {
      if ($('pVolume').options.length <= 1) {
        (m.volumes || []).forEach(function (v) {
          var o = document.createElement('option');
          o.value = v; o.textContent = v;
          $('pVolume').appendChild(o);
        });
      }
      // Só preenche o que está vazio: um pedido recusado volta com o que a
      // loja escreveu, e sobrescrever apagaria a correção em digitação.
      if (!$('pEmpresa').value) $('pEmpresa').value = m.name || '';
      if (!$('pRazao').value) $('pRazao').value = m.legalName || '';
      if (!$('pCnpj').value) $('pCnpj').value = m.taxId || '';
      if (!$('pTelefone').value) $('pTelefone').value = m.phone || '';
      if (!$('pSite').value) $('pSite').value = m.website || '';
      if (!$('pWebhook').value) $('pWebhook').value = m.callbackUrl || '';
      if (!$('pDescricao').value && dados.application) {
        $('pDescricao').value = dados.application.description || '';
      }
      if (dados.application && dados.application.expectedVolume) {
        $('pVolume').value = dados.application.expectedVolume;
      }
    }

    // ── aba Integração ──
    var aprovada = m.status === 'aprovado';
    $('integracaoBloqueada').className = aprovada ? 'banner a hide' : 'banner a';
    $('integracaoBox').className = aprovada ? '' : 'hide';
    $('chaveAtual').textContent = m.apiKeyPrefix
      ? m.apiKeyPrefix + '…  (emitida em ' + quando(m.apiKeyIssuedAt) + ')'
      : 'nenhuma chave emitida ainda';
    $('emitirChave').textContent = m.apiKeyPrefix ? 'Emitir nova chave' : 'Emitir chave';
    $('iCallback').value = m.callbackUrl || '';
    $('iReturn').value = m.returnUrl || '';

    // ── aba Saques ──
    if (m.payoutWallet) $('wallet').value = m.payoutWallet;
    if (m.payoutFiatDetails) $('dadosFiat').value = m.payoutFiatDetails;
    if (m.payoutCurrency) $('moeda').value = m.payoutCurrency;
    if (m.preferredPayout) $('metodo').value = m.preferredPayout;
    trocarMetodo();
    $('ajudaSaque').textContent =
      'Disponível: ' + brl(b.available) + '. Mínimo de R$ 10,00. ' +
      'O valor sai do saldo assim que você pede, e é convertido pela cotação do momento do envio.';

    // ── aba Configurações ──
    $('gEmpresa').value = m.name || '';
    $('gRazao').value = m.legalName || '';
    $('gCnpj').value = m.taxId || '';
    $('gTelefone').value = m.phone || '';
    $('gSite').value = m.website || '';
    $('gEmailFixo').value = m.email;
    $('resumoConta').innerHTML =
      'Conta criada em ' + esc(quando(m.createdAt)) + '.<br>' +
      'Última entrada: ' + esc(quando(m.lastLoginAt)) + '.<br>' +
      'Senha alterada em: ' + esc(quando(m.passwordChangedAt)) + '.';

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
        '<td data-l="Quando" class="dim">' + esc(quando(s.createdAt)) + '</td>' +
        '<td data-l="Valor" class="num">' + brl(s.amount) + '</td>' +
        '<td data-l="Forma">' + forma + '</td>' +
        '<td data-l="Estado">' + (ESTADO_SAQUE[s.status] || esc(s.status)) + '</td>' +
        '<td data-l="Comprovante">' + comprovante + '</td></tr>';
    }).join('') || '<tr><td class="dim">nenhum saque ainda</td></tr>';

    document.querySelector('#tabelaVendas tbody').innerHTML = (dados.sales || []).map(function (v) {
      return '<tr>' +
        '<td data-l="Quando" class="dim">' + esc(quando(v.createdAt)) + '</td>' +
        '<td data-l="Referência" class="mono">' + esc(v.reference) + '</td>' +
        '<td data-l="Pedido" class="dim">' + esc(v.externalId || '—') + '</td>' +
        '<td data-l="Valor" class="num">' + esc(v.amount) + '</td>' +
        '<td data-l="Estado">' + (ESTADO_VENDA[v.status] || esc(v.status)) + '</td></tr>';
    }).join('') || '<tr><td class="dim">nenhuma venda ainda</td></tr>';
  }

  function deslogar() {
    guardar(null);
    dadosAtuais = null;
    $('painel').classList.add('hide');
    $('forcado').classList.add('hide');
    $('porta').classList.remove('hide');
    $('sair').classList.add('hide');
    $('quem').classList.add('hide');
  }

  function carregar() {
    return api('/api/dashboard').then(mostrar).catch(function (err) {
      if (String(err.message).indexOf('login') !== -1) deslogar();
      else alerta(err.message);
    });
  }

  // ═══════════ Entrada ═══════════

  function entrarCom(caminho, corpo, botao) {
    alerta('');
    botao.disabled = true;
    return api(caminho, { method: 'POST', body: JSON.stringify(corpo) })
      .then(function (r) {
        guardar(r.token);
        $('password').value = ''; $('cSenha').value = ''; $('cSenha2').value = '';
        return carregar();
      })
      .catch(function (err) { alerta(err.message); })
      .then(function () { botao.disabled = false; });
  }

  $('entrar').addEventListener('click', function () {
    entrarCom('/api/login', {
      email: $('email').value.trim(), password: $('password').value
    }, $('entrar'));
  });
  $('password').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') $('entrar').click();
  });

  $('criar').addEventListener('click', function () {
    if ($('cSenha').value !== $('cSenha2').value) {
      alerta('As duas senhas não são iguais.'); return;
    }
    entrarCom('/api/signup', {
      companyName: $('cEmpresa').value.trim(),
      email: $('cEmail').value.trim(),
      password: $('cSenha').value
    }, $('criar'));
  });

  $('pedirSenha').addEventListener('click', function () {
    alerta('');
    $('pedirSenha').disabled = true;
    api('/api/password/forgot', {
      method: 'POST', body: JSON.stringify({ email: $('fEmail').value.trim() })
    }).then(function () {
      alerta('Pedido registrado. Nosso operador vai confirmar quem você é e emitir uma ' +
             'senha temporária. Tenha o telefone do cadastro à mão.', 'o');
    }).catch(function (err) { alerta(err.message); })
      .then(function () { $('pedirSenha').disabled = false; });
  });

  $('sair').addEventListener('click', function () {
    api('/api/logout', { method: 'POST' }).catch(function () {}).then(function () {
      guardar(null);
      location.reload();
    });
  });

  // ═══════════ Senha temporária ═══════════

  $('trocarForcado').addEventListener('click', function () {
    alerta('');
    if ($('tNova').value !== $('tNova2').value) { alerta('As duas senhas não são iguais.'); return; }
    $('trocarForcado').disabled = true;
    api('/api/password', {
      method: 'POST',
      body: JSON.stringify({ current: $('tAtual').value, next: $('tNova').value })
    }).then(function () {
      $('tAtual').value = ''; $('tNova').value = ''; $('tNova2').value = '';
      alerta('Senha definida. Bem-vindo.', 'o');
      return carregar();
    }).catch(function (err) { alerta(err.message); })
      .then(function () { $('trocarForcado').disabled = false; });
  });

  // ═══════════ Avisos ═══════════

  $('lerTudo').addEventListener('click', function () {
    api('/api/notifications/read', { method: 'POST', body: '{}' })
      .then(carregar).catch(function (err) { alerta(err.message); });
  });

  // ═══════════ Pedido de análise ═══════════

  $('enviarPedido').addEventListener('click', function () {
    alerta('');
    var corpo = {
      companyName: $('pEmpresa').value.trim(),
      legalName: $('pRazao').value.trim(),
      taxId: $('pCnpj').value.trim(),
      phone: $('pTelefone').value.trim(),
      website: $('pSite').value.trim(),
      callbackUrl: $('pWebhook').value.trim(),
      expectedVolume: $('pVolume').value,
      description: $('pDescricao').value.trim()
    };
    if (!corpo.companyName) { alerta('Informe o nome da empresa.'); return; }

    // Campo vazio sai do corpo: o servidor distingue "não informado" de
    // "informado em branco", e a validação de URL só roda no que veio.
    Object.keys(corpo).forEach(function (k) { if (!corpo[k]) delete corpo[k]; });

    $('enviarPedido').disabled = true;
    api('/api/application', { method: 'POST', body: JSON.stringify(corpo) })
      .then(function () {
        alerta('Pedido enviado. A resposta aparece aqui no painel.', 'o');
        abrirAba('inicio');
        return carregar();
      })
      .catch(function (err) { alerta(err.message); })
      .then(function () { $('enviarPedido').disabled = false; });
  });

  // ═══════════ Integração ═══════════

  $('emitirChave').addEventListener('click', function () {
    var trocando = dadosAtuais && dadosAtuais.merchant.apiKeyPrefix;
    if (trocando && !confirm('Emitir uma chave nova faz a atual parar de funcionar na hora. ' +
                             'A sua loja fica sem cobrar até você atualizar o servidor dela.\n\nContinuar?')) return;

    alerta('');
    $('emitirChave').disabled = true;
    api('/api/api-key', { method: 'POST', body: '{}' }).then(function (r) {
      $('chaveNova').textContent = r.apiKey;
      $('chaveNovaBox').classList.remove('hide');
      $('copiarChave').textContent = 'Copiar';
      return carregar();
    }).catch(function (err) { alerta(err.message); })
      .then(function () { $('emitirChave').disabled = false; });
  });

  $('copiarChave').addEventListener('click', function () {
    var texto = $('chaveNova').textContent;
    if (!navigator.clipboard) { alerta('Selecione a chave e copie à mão.'); return; }
    navigator.clipboard.writeText(texto).then(function () {
      $('copiarChave').textContent = 'Copiada';
    }).catch(function () { alerta('Não consegui copiar — selecione e copie à mão.'); });
  });

  $('verSegredo').addEventListener('click', function () {
    api('/api/webhook-secret').then(function (r) {
      $('segredoWebhook').textContent = r.webhookSecret;
      $('verSegredo').classList.add('hide');
    }).catch(function (err) { alerta(err.message); });
  });

  $('trocarSegredo').addEventListener('click', function () {
    if (!confirm('As notificações passam a ser assinadas com o segredo novo. ' +
                 'A sua loja vai recusá-las até você atualizar o valor lá.\n\nContinuar?')) return;
    api('/api/webhook-secret', { method: 'POST', body: '{}' }).then(function (r) {
      $('segredoWebhook').textContent = r.webhookSecret;
      $('verSegredo').classList.add('hide');
      alerta('Segredo trocado. Atualize-o no servidor da sua loja.', 'o');
    }).catch(function (err) { alerta(err.message); });
  });

  $('salvarUrls').addEventListener('click', function () {
    alerta('');
    api('/api/profile', {
      method: 'POST',
      body: JSON.stringify({ callbackUrl: $('iCallback').value.trim(), returnUrl: $('iReturn').value.trim() })
    }).then(function () {
      alerta('URLs salvas.', 'o');
      return carregar();
    }).catch(function (err) { alerta(err.message); });
  });

  // ═══════════ Configurações ═══════════

  $('salvarPerfil').addEventListener('click', function () {
    alerta('');
    api('/api/profile', {
      method: 'POST',
      body: JSON.stringify({
        companyName: $('gEmpresa').value.trim(),
        legalName: $('gRazao').value.trim(),
        taxId: $('gCnpj').value.trim(),
        phone: $('gTelefone').value.trim(),
        website: $('gSite').value.trim()
      })
    }).then(function () {
      alerta('Dados salvos.', 'o');
      return carregar();
    }).catch(function (err) { alerta(err.message); });
  });

  $('trocarSenha').addEventListener('click', function () {
    alerta('');
    if ($('sNova').value !== $('sNova2').value) { alerta('As duas senhas não são iguais.'); return; }
    $('trocarSenha').disabled = true;
    api('/api/password', {
      method: 'POST',
      body: JSON.stringify({ current: $('sAtual').value, next: $('sNova').value })
    }).then(function () {
      $('sAtual').value = ''; $('sNova').value = ''; $('sNova2').value = '';
      alerta('Senha trocada. As outras sessões foram encerradas.', 'o');
      return carregar().then(carregarSessoes);
    }).catch(function (err) { alerta(err.message); })
      .then(function () { $('trocarSenha').disabled = false; });
  });

  function carregarSessoes() {
    return api('/api/sessions').then(function (r) {
      document.querySelector('#tabelaSessoes tbody').innerHTML = (r.sessions || []).map(function (s) {
        return '<tr>' +
          '<td data-l="Entrou em" class="dim">' + esc(quando(s.createdAt)) + '</td>' +
          '<td data-l="De onde" class="mono dim">' + esc(s.clientIp || '—') + '</td>' +
          '<td data-l="Vale até" class="dim">' + esc(quando(s.expiresAt)) + '</td>' +
          '<td data-l="">' + (s.current ? '<span class="ok">este aparelho</span>' : '') + '</td></tr>';
      }).join('') || '<tr><td class="dim">nenhuma sessão</td></tr>';
    }).catch(function () { /* sessão caiu; o painel já avisa pelo dashboard */ });
  }

  $('encerrarSessoes').addEventListener('click', function () {
    if (!confirm('Todos os outros aparelhos vão precisar entrar de novo. Continuar?')) return;
    api('/api/sessions/revoke', { method: 'POST', body: '{}' }).then(function (r) {
      alerta(r.revoked + ' sessão(ões) encerrada(s).', 'o');
      return carregarSessoes();
    }).catch(function (err) { alerta(err.message); });
  });

  // ═══════════ Saques ═══════════

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
    el.textContent = moeda === 'BRL'
      ? 'Você recebe ' + brl(valor) + ' na conta informada.'
      : 'O valor em ' + moeda + ' é calculado no câmbio do dia da transferência.';
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
      return carregar();
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
      alerta('Saque solicitado. Você acompanha o estado logo abaixo.', 'o');
      $('valor').value = '';
      return carregar();
    }).catch(function (err) { alerta(err.message); })
      .then(function () { $('pedirSaque').disabled = false; });
  });

  if (sessao) carregar();
})();
</script>
</body>
</html>`;
