/**
 * Página pública de parceiros — a porta de entrada comercial.
 *
 * Ela já foi um formulário anônimo de candidatura. Deixou de ser: o pedido
 * mudou para dentro da conta, em /loja. A troca resolve o problema que o
 * formulário não tinha como resolver — sem conta não havia para onde mandar a
 * resposta da análise, e a página prometia "respondemos por e-mail" num
 * sistema que não manda e-mail nenhum.
 *
 * O que sobra aqui é o que uma página pública faz bem: explicar o negócio e
 * levar para o cadastro.
 */
export const PARTNER_PAGE_HTML = String.raw`<!doctype html>
<html lang="pt">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0f1216">
<title>Faça vendas conosco</title>
<style>
  :root{--bg:#0f1216;--panel:#171b21;--panel2:#1e242c;--line:#2a323c;--tx:#e6eaef;--dim:#94a1b2;--ok:#3ddc97;--acc:#5b9dff}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--tx);
       font:15px/1.65 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  main{max-width:660px;margin:0 auto;
       padding:calc(40px + env(safe-area-inset-top)) 20px calc(60px + env(safe-area-inset-bottom))}
  h1{font-size:28px;line-height:1.25;margin:0 0 8px;letter-spacing:-.02em}
  p.lead{color:var(--dim);font-size:16px;margin:0 0 30px}
  h2{font-size:12px;text-transform:uppercase;letter-spacing:.07em;color:var(--dim);margin:0 0 14px}
  section{background:var(--panel);border:1px solid var(--line);border-radius:12px;
          padding:20px;margin-bottom:14px}
  .passos{display:grid;gap:12px;margin:0;padding:0;list-style:none}
  .passos li{display:flex;gap:12px;align-items:flex-start;font-size:14px;color:var(--dim)}
  .passos b{display:grid;place-items:center;flex:0 0 24px;height:24px;border-radius:50%;
            background:var(--panel2);border:1px solid var(--line);color:var(--tx);font-size:12px}
  .passos li span b{display:inline;background:none;border:0;height:auto;color:var(--tx);font-size:14px}
  a.cta{display:block;text-align:center;text-decoration:none;background:var(--acc);color:#07101f;
        font-weight:650;border-radius:10px;padding:15px;margin:0 0 10px;font-size:16px}
  a.cta.ghost{background:var(--panel);color:var(--tx);border:1px solid var(--line);font-weight:500}
  .grade{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px}
  .grade div b{display:block;font-size:14px;margin-bottom:2px}
  .grade div span{color:var(--dim);font-size:13px}
  footer{color:var(--dim);font-size:12px;text-align:center;margin-top:28px;line-height:1.8}
  a{color:var(--acc)}
</style>
</head>
<body>
<main>
  <h1>Faça vendas conosco</h1>
  <p class="lead">
    Coloque o nosso checkout na sua loja. Seus clientes pagam em reais por Pix ou cartão,
    e você recebe como preferir — em cripto na sua carteira ou em dinheiro na sua conta.
  </p>

  <section>
    <h2>Como funciona</h2>
    <ol class="passos">
      <li><b>1</b><span>Você cria a sua conta — a mesma que serve para comprar cripto.</span></li>
      <li><b>2</b><span>Abre a sua loja e envia os dados da empresa para análise.</span></li>
      <li><b>3</b><span>A resposta aparece no seu painel. Aprovado, você mesmo emite a chave de API.</span></li>
      <li><b>4</b><span>Integra seguindo a <a href="/docs" target="_blank" rel="noopener">documentação</a> e começa a vender.</span></li>
    </ol>
  </section>

  <section>
    <h2>O que você tem no painel</h2>
    <div class="grade">
      <div><b>Faturamento</b><span>Cada venda paga, com referência e o pedido do seu lado.</span></div>
      <div><b>Saldo e saque</b><span>Peça quando quiser, em SOL ou em real, dólar e euro.</span></div>
      <div><b>Suas credenciais</b><span>Chave de API e segredo de webhook, emitidos e trocados por você.</span></div>
      <div><b>Avisos</b><span>Análise, saque enviado, chave trocada — tudo chega aqui.</span></div>
    </div>
  </section>

  <a class="cta" href="/conta?novo=1">Criar a minha conta</a>
  <a class="cta ghost" href="/conta">Já tenho conta — entrar</a>

  <footer>
    A análise é feita por uma pessoa e a resposta chega no painel da sua conta.<br>
    A <a href="/docs">documentação da API</a> é pública — dá para ler antes de se cadastrar.
  </footer>
</main>
</body>
</html>`;
