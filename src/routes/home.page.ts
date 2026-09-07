/**
 * Porta de entrada do domínio.
 *
 * Antes, `/` respondia 404: quem chegasse pelo endereço puro — o caso mais
 * comum quando alguém recebe o link por mensagem — batia num erro. São três
 * públicos diferentes chegando pelo mesmo lugar, e cada um precisa de uma
 * porta: quem quer comprar cripto, quem tem loja e quer vender, e a loja que
 * já é parceira e vem ver o faturamento.
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
  main{max-width:660px;margin:0 auto;
       padding:calc(48px + env(safe-area-inset-top)) 20px calc(60px + env(safe-area-inset-bottom))}
  h1{font-size:30px;line-height:1.25;margin:0 0 10px;letter-spacing:-.02em}
  p.lead{color:var(--dim);font-size:16px;margin:0 0 36px}
  a.porta{display:block;text-decoration:none;color:inherit;background:var(--panel);
          border:1px solid var(--line);border-radius:14px;padding:20px;margin-bottom:12px;
          transition:border-color .15s}
  a.porta:hover{border-color:var(--acc)}
  a.porta b{display:block;font-size:17px;font-weight:650;margin-bottom:3px}
  a.porta span{color:var(--dim);font-size:14px}
  a.porta .seta{float:right;color:var(--acc);font-size:18px;line-height:1.2}
  .destaque{border-color:#2c4a7a;background:linear-gradient(180deg,#1a2130,var(--panel))}
  footer{color:var(--dim);font-size:12px;margin-top:36px;text-align:center;line-height:1.9}
  footer a{color:var(--dim)}
</style>
</head>
<body>
<main>
  <h1>Pagamentos em reais,<br>entrega em cripto.</h1>
  <p class="lead">
    Pix e cartão de um lado, Solana do outro. Sem intermediário entre o pagamento e a carteira.
  </p>

  <a class="porta" href="/pay">
    <span class="seta">&rarr;</span>
    <b>Comprar SOL</b>
    <span>Pague por Pix ou cartão e receba na sua carteira. Criamos uma para você se não tiver.</span>
  </a>

  <a class="porta destaque" href="/parceiros">
    <span class="seta">&rarr;</span>
    <b>Faça vendas conosco</b>
    <span>Coloque o nosso checkout na sua loja. Seus clientes pagam em reais, você recebe
      como preferir — em cripto ou na sua conta.</span>
  </a>

  <a class="porta" href="/loja">
    <span class="seta">&rarr;</span>
    <b>Já sou parceiro</b>
    <span>Acompanhe o faturamento da sua loja e peça saque.</span>
  </a>

  <footer>
    <a href="/docs">Documentação da API</a>
  </footer>
</main>
</body>
</html>`;
