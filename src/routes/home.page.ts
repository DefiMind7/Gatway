/**
 * Landing pública — o topo do funil.
 *
 * Aqui não há escolha de operação, só duas: entrar ou criar conta. As três
 * portas (comprar, vender, carteira) mudaram para `/inicio`, depois do login.
 *
 * A razão é que cada uma delas precisa de conta para fazer qualquer coisa:
 * comprar exige carteira, vender exige loja, e as duas exigem alguém a quem
 * responder. Oferecê-las antes do cadastro dava a impressão de três caminhos
 * abertos que na prática desembocavam todos no mesmo formulário de login —
 * só que mais adiante, depois da pessoa já ter escolhido.
 */
export const HOME_PAGE_HTML = String.raw`<!doctype html>
<html lang="pt">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0f1216">
<title>Gateway de pagamentos</title>
<style>
  :root{--bg:#0f1216;--panel:#171b21;--panel2:#1e242c;--line:#2a323c;--tx:#e6eaef;--dim:#94a1b2;--ok:#3ddc97;--acc:#5b9dff}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--tx);
       font:15px/1.65 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  main{max-width:620px;margin:0 auto;
       padding:calc(60px + env(safe-area-inset-top)) 20px calc(60px + env(safe-area-inset-bottom))}
  h1{font-size:34px;line-height:1.2;margin:0 0 12px;letter-spacing:-.025em}
  p.lead{color:var(--dim);font-size:17px;margin:0 0 34px}
  a.cta{display:block;text-align:center;text-decoration:none;background:var(--acc);color:#07101f;
        font-weight:650;border-radius:10px;padding:16px;margin:0 0 10px;font-size:16px}
  a.cta.ghost{background:var(--panel);color:var(--tx);border:1px solid var(--line);font-weight:500}
  .provas{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:16px;
          margin:38px 0 0;padding:24px 0 0;border-top:1px solid var(--line)}
  .provas b{display:block;font-size:14px;margin-bottom:3px}
  .provas span{color:var(--dim);font-size:13px}
  footer{color:var(--dim);font-size:12px;text-align:center;margin-top:34px;line-height:1.9}
  a{color:var(--acc)}
</style>
</head>
<body>
<main>
  <h1>Pagamentos em reais,<br>entrega em cripto.</h1>
  <p class="lead">
    Pix e cartão de um lado, Solana do outro. Compre para você, ou receba
    pagamentos na sua loja — com a mesma conta.
  </p>

  <a class="cta" href="/conta?novo=1">Criar a minha conta</a>
  <a class="cta ghost" href="/conta">Já tenho conta — entrar</a>

  <div class="provas">
    <div><b>Carteira na hora</b><span>Criamos uma para você no cadastro. A chave é sua quando quiser.</span></div>
    <div><b>Pix e cartão</b><span>Os dois trilhos, sem intermediário entre o pagamento e a carteira.</span></div>
    <div><b>Checkout para lojas</b><span>Seus clientes pagam em reais; você recebe em cripto ou na conta.</span></div>
  </div>

  <footer>
    Quer integrar na sua loja? <a href="/parceiros">Faça vendas conosco</a><br>
    A <a href="/docs">documentação da API</a> é pública.
  </footer>
</main>
</body>
</html>`;
