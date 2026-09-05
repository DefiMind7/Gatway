# Gateway de pagamentos — como rodar

Recebe reais por Pix ou cartão e entrega SOL na carteira do cliente.

## Rodar (3 comandos)

Precisa de [Node.js 20 ou mais novo](https://nodejs.org). Confira com `node -v`.

```bash
npm install
npm run setup
npm run dev
```

O `setup` gera as chaves desta cópia, escreve o `.env` e cria o banco. Ele
imprime no fim a **senha do painel** — guarde.

Depois abra:

| | |
|---|---|
| Checkout do cliente | http://localhost:3000/pay |
| Painel do operador | http://localhost:3000/admin |
| Documentação da API | http://localhost:3000/docs |

No celular, na mesma rede: descubra o IP da máquina (`ipconfig` no Windows,
`ifconfig` no Mac) e use `http://SEU-IP:3000/pay`. Dá para instalar na tela
inicial — o app é PWA, funciona em Android e iPhone.

## O que dá para testar sem configurar nada

- **criar conta** — a carteira Solana nasce junto, e é sempre a mesma daquele cliente
- **ver a carteira** — saldo lido da blockchain, endereço, exportar a chave para o Phantom
- **gerar um depósito** e acompanhar o estado
- **enviar SOL** para qualquer carteira da rede (precisa de saldo)
- **painel completo** — fila de entrega, livro-razão, lojas integradas, taxas

## O que precisa de configuração

**Pix e cartão** dependem de uma conta Mercado Pago. Com as credenciais no
`.env`, troque `DEPOSIT_METHODS` para `PIXQR,CARD`:

```
MERCADOPAGO_ACCESS_TOKEN=APP_USR-…
MERCADOPAGO_PUBLIC_KEY=APP_USR-…
DEPOSIT_METHODS=PIXQR,CARD
```

Contas do Mercado Pago só processam cartões do próprio país: uma conta
brasileira cobra em BRL e não aceita cartão estrangeiro.

**Entregar SOL de verdade** exige saldo no vault (o endereço sai no `setup`):

- ~0,003 SOL para as taxas de rede
- USDC como estoque — é ele que vira o SOL do cliente

```bash
npm run preflight     # diz exatamente o que falta
npm run selftest      # roda um ciclo inteiro, do pagamento à entrega
```

## Como o dinheiro funciona

O cliente paga em reais na sua conta. Uma parte fica com você (30% por padrão,
ajustável no painel) e o resto vira SOL, vindo do estoque de USDC do vault.

Ou seja: **você adianta a cripto e fica com o fiat.** O painel mostra a fila de
quem pagou e ainda não recebeu, com quanto de USDC comprar para zerá-la.

## Avisos que valem a leitura

**Este sistema guarda chaves privadas de clientes.** Elas ficam cifradas no
banco com a `WALLET_ENCRYPTION_KEY` do `.env`. Perder essa chave, ou perder o
banco, é perder o dinheiro dos clientes — sem recuperação. Faça backup dos
dois, em lugares diferentes.

**Nunca compartilhe o `.env`.** Ele contém a chave do vault (o seu dinheiro) e
a chave que abre as carteiras dos clientes. Cada instalação gera as suas: rode
`npm run setup` em vez de copiar o arquivo de alguém.

**Estorno de cartão é irreversível para você.** O cliente pode contestar
semanas depois de o SOL já ter saído, e cripto enviada não volta. Comece com
`DEPOSIT_MAX_AMOUNT` baixo.

## Comandos úteis

| | |
|---|---|
| `npm run dev` | sobe com recarga automática |
| `npm run preflight` | confere se dá para receber dinheiro real |
| `npm run selftest` | testa o ciclo completo de ponta a ponta |
| `npm run keygen -- --write` | gera um vault novo (com o antigo vazio) |
| `npm run walletkey` | gera uma chave de cifra nova |

Detalhes de arquitetura: `README.md`. Publicação: `DEPLOY.md`.
