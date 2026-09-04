# Solana Fiat Gateway — modelo broker

O cliente paga em **EUR/USD/BRL**, o on-ramp credita stablecoin no vault, o
backend faz **swap para SOL** via Jupiter, envia ao cliente o SOL **menos a
taxa**, e a taxa acumulada é **distribuída aos sócios em horário fixo diário**.

```
cliente paga fiat
      │
      ▼
on-ramp mais barato ──webhook HMAC──► POST /webhook/fiat-payment
      │                                      │ 202 imediato
      │ settlement USDC no vault             ▼
      │                              Order PENDING
      │                                      │ aguarda depósito (reserva FIFO)
      │                                      ▼
      │                                 PROCESSING
      │                                      │ swap USDC→SOL (Jupiter)
      │                                      ▼
      │                                   SWAPPED
      │                                      │ cliente recebe SOL − taxa
      │                                      ▼
      │                                   SETTLED ──── taxa retida no vault
      │                                      │              (lucro acumulado)
      │                                      │
      │        horário fixo diário  ─────────┤
      │        (ex.: 21:30 America/Sao_Paulo)│
      │                                      ▼
      │                              PayoutRun: split por bps
      │                                      ▼
      └───────────────────────────────► DISTRIBUTED
```

**Onde entra o dinheiro:** a receita é só a taxa. `feeBps = custo do melhor
on-ramp (tempo real) + margem`, limitada por piso/teto. Provedor mais barato =
mais margem retida sem mexer no preço final do cliente.

## Receber dinheiro hoje: o provedor interno (`/pay`)

Um on-ramp de verdade (SpherePay, MoonPay, Transak) só libera webhook depois de
onboarding de empresa — semanas. Para um teste com poucas pessoas há um caminho
que sobe hoje: **o operador é o provedor**. O checkout público fica em `/pay`,
a confirmação gera o **mesmo `NormalizedFiatEvent`** que um provedor externo
geraria, e a pipeline a jusante (swap → liquidação → lucro → distribuição) não
muda uma linha.

```
cliente abre /pay
      │  escolhe trilho, valor e a carteira dele
      ▼
DepositIntent AWAITING_PAYMENT  (referência GW-XXXXXX, TTL 45 min)
      │
      ├─ trilho USDC ──► cliente manda USDC ao vault
      │                        │ varredura on-chain casa pelo VALOR EXATO
      │                        ▼
      │                  confirmação automática
      │
      └─ trilho fiat ──► cliente transfere (Pix/SEPA/MB Way/Revolut)
                               │ operador confere o extrato e clica no painel
                               ▼
                         confirmação manual
      │
      ▼
Order PENDING ──► (pipeline existente, sem alteração) ──► SETTLED
```

### Os dois trilhos, e a diferença que importa

| | **USDC** | **CARD** (Mercado Pago) | **Pix / SEPA / MB Way / Revolut** |
|---|---|---|---|
| Confirmação | automática (on-chain) | automática (PSP) | manual, no painel |
| Preparo | nenhum — o destino é o vault | credencial do MP | `payTo` em `DEPOSIT_INSTRUCTIONS_JSON` |
| Quem lastreia a ordem | o próprio depósito | **o float de USDC do vault** | **o float de USDC do vault** |
| Retenção em fiat | não se aplica | sim (30% default) | sim (30% default) |
| Risco do operador | nenhum: o dinheiro chegou antes | estorno do cartão depois do SOL enviado | confirmar sem o dinheiro ter caído é perda real |

**O ponto que decide se isto funciona:** num trilho fiat o gateway não recebe
stablecoin nenhuma — ele recebe euro na sua conta e paga a ordem com o USDC que
já está no vault. Sem float, a ordem fica em `DEPOSIT_NOT_COVERED` até haver
saldo. O painel mostra o float na visão geral justamente por isso.

### Como o depósito USDC é identificado

Pelo **valor exato**, e só. Memo não sobrevive à UI da maioria das carteiras, e
o remetente muitas vezes não é quem recebe o SOL (exchange, carteira de
terceiro). Consequência aceita de propósito: duas intenções abertas com o mesmo
valor são **ambíguas**, e aí a varredura se recusa a decidir e deixa para o
operador — errar aqui pagaria SOL para a carteira errada.

`depositSignature` é UNIQUE: a mesma transferência nunca lastreia duas ordens.

### Carteira gerada: o cliente não precisa ter uma

Pedir a alguém que nunca usou cripto que cole um endereço Solana é a maior
fricção possível num checkout. Com `WALLET_GENERATION=true` o campo some: o
gateway cria a carteira no ato, o SOL cai nela, e o cliente exporta a chave
para o Phantom quando quiser.

**Isso faz de você custodiante.** Enquanto o cliente não pedir a chave, o
dinheiro é dele e a chave é sua. As defesas não são opcionais:

| | |
|---|---|
| Chave privada no banco | AES-256-GCM, nonce único por carteira, tag de autenticação |
| Chave mestra | só em `WALLET_ENCRYPTION_KEY`, fora do banco — as duas metades precisam vazar juntas |
| Quem pode pedir a chave | só o navegador que criou o depósito, via token de posse (a `reference` não basta: ela viaja na URL) |
| Entrega da chave | registrada com data em `revealedAt` |
| Boot | falha se a chave mestra não abrir as carteiras existentes |

Duas obrigações operacionais, e não há como o código cobrir por você:

1. **Backup de `WALLET_ENCRYPTION_KEY`** fora do servidor e do repositório.
2. **Backup do banco** — as chaves cifradas moram nele.

Perder qualquer um dos dois é perder o dinheiro de todos os clientes, sem
recuperação. Se isso não for aceitável para o seu caso, rode com
`WALLET_GENERATION=false` e volte a exigir a carteira do cliente.

### A trava de float

`DEPOSIT_REQUIRE_FLOAT=true` (padrão) recusa o depósito quando o vault não tem
USDC para lastreá-lo, **antes** de mostrar qualquer instrução de pagamento.

Sem ela, o pior cenário do produto acontece calado: o cliente paga no cartão, o
dinheiro entra na sua conta, e a ordem fica presa em `DEPOSIT_NOT_COVERED`
esperando um USDC que não existe. Dizer "indisponível" antes de cobrar é muito
melhor do que devolver dinheiro depois.

O cálculo desconta o que já está prometido: ordens que ainda não swaparam **e**
intenções fiat em aberto. Duas pessoas não conseguem reservar o mesmo saldo.
O trilho USDC não passa por essa trava — ele traz o próprio lastro.

### Pré-voo

```bash
npm run preflight
```

Verifica, e diz o que fazer em cada falha: rede (devnet mata o swap, porque o
Jupiter não existe lá), mint, gás do vault, float, Jupiter respondendo,
credencial do PSP, custódia, retenção e limites. Sai com código 1 se houver
bloqueio — dá para usar como passo de deploy.

### Cartão (Mercado Pago) e a divisão 30/70

O trilho `CARD` fecha o caso "cliente paga no cartão, uma parte fica comigo em
fiat, o resto vira SOL":

```
cliente paga 100 BRL no cartão
        │  Mercado Pago (Checkout Pro)
        ▼
100 BRL na conta do MP   ──30%──►  30 BRL ficam lá (receita, saca para o banco)
        │
        └──70%──►  70 BRL × câmbio ──► 12,60 USDC do float do vault
                                              │ swap Jupiter
                                              ▼
                                    SOL na carteira do cliente
```

A retenção é configurada no painel (`Divisão do dinheiro que entra`,
`fiatRetainedBps`, default 3000 = 30%) e vale para **todos os trilhos fiat** —
cartão, Pix, SEPA, MB Way, Revolut. O trilho USDC fica de fora: quem entrega
stablecoin não tem "parte em fiat" a reter, e ali a receita continua sendo a
taxa on-chain.

**Nas ordens com retenção a taxa on-chain é zero.** A receita já foi tirada
antes da conversão; cobrar `feeBps` por cima seria cobrar duas vezes pela mesma
operação. Consequência no motor de distribuição: essas ordens não têm lucro em
lamports, então não entram em `PayoutRun` — são encerradas direto como
`DISTRIBUTED`, e a divisão dos 30% entre sócios é transferência bancária, feita
por fora. O total retido por moeda aparece na visão geral do painel.

**O dinheiro não é conferido pelo que o cliente diz.** O webhook do MP carrega
só um id; o estado e o valor vêm sempre de uma consulta à API do MP com a nossa
credencial. Pagar 50 numa intenção de 100 é recusado com
`PAYMENT_AMOUNT_MISMATCH` — verificado.

**Dois caminhos de confirmação, de propósito:**

| | webhook | consulta ativa |
|---|---|---|
| Precisa de URL pública | sim | não |
| Funciona em `localhost` | não | **sim** |
| Quem dispara | Mercado Pago | o poll da página do cliente e o cron |

A consulta ativa não é redundância defensiva: é o que faz o cartão funcionar em
desenvolvimento sem túnel, e o que salva um webhook perdido em produção (o MP
desiste depois de algumas tentativas).

**Configurar:**

```bash
DEPOSIT_METHODS=USDC,CARD
MERCADOPAGO_ACCESS_TOKEN=TEST-...      # Suas integrações → Credenciais de teste
MERCADOPAGO_SANDBOX=true
MERCADOPAGO_WEBHOOK_SECRET=...         # obrigatório em produção
PUBLIC_BASE_URL=https://seu-deploy     # vazio em local
```

Com credencial de teste, o pagamento usa os cartões de teste do MP e nenhum
dinheiro real se move. Sem `MERCADOPAGO_ACCESS_TOKEN`, `CARD` em
`DEPOSIT_METHODS` **impede o boot** — um botão de cartão sem credencial é um
botão que leva a lugar nenhum.

**O que o Mercado Pago cobra vem antes da sua conta:** a taxa dele (alguns por
cento, e mais se for parcelado) sai dos 100 que o cliente pagou. Os 30% de
retenção são calculados sobre o valor cheio, então a sua margem real é
30% menos a taxa do PSP.

### Subir em 5 minutos (só USDC)

```bash
DEPOSIT_ENABLED=true
DEPOSIT_METHODS=USDC
DEPOSIT_MIN_AMOUNT=5
DEPOSIT_MAX_AMOUNT=100     # o seu limite de exposição no teste
```

Só isso. Abra `/pay`, mande USDC, acompanhe em `/admin`.

Para um trilho fiat, acrescente o destino — sem ele o app **não sobe**, de
propósito (melhor falhar no boot do que mostrar ao cliente uma página que pede
dinheiro sem dizer para onde):

```bash
DEPOSIT_METHODS=USDC,PIX
DEPOSIT_INSTRUCTIONS_JSON='{"PIX":{"payTo":"sua-chave@email.com","holder":"Seu Nome"}}'
```

E defina o **câmbio do operador** no painel (`Câmbio do operador`): quanto USDC
do float vale cada unidade recebida. Não é cotação de mercado — é o câmbio que
você consegue no banco. O default é 1:1 em tudo, correto para USD e
deliberadamente errado para EUR/BRL, para obrigar a decisão explícita.

### Quem confirma, e quando

- **Varredura on-chain** — roda no tick do cron, no botão do painel e, o mais
  importante, **no poll da própria página do cliente**. Em serverless o cron
  mais frequente do plano gratuito é diário; o poll do cliente é o relógio que
  existe. O mesmo poll também reempurra uma ordem que não coube no orçamento
  da invocação. Tudo throttlado por lock no banco.
- **Painel** — `Depósitos — fila do provedor interno`: confirmar, cancelar,
  varrer. Confirmar é irreversível e move dinheiro; o botão avisa.

### Limites que seguram o risco

Nada disso depende de a referência ser secreta (ela é curta, para ser ditada
por telefone). O que segura é servidor: faixa `DEPOSIT_MIN/MAX_AMOUNT`, rate
limit por IP contado **no banco** (`DEPOSIT_MAX_INTENTS_PER_HOUR` — um Map em
memória não freia nada com N instâncias serverless), teto por ordem
(`MAX_ORDER_INPUT_RAW`), e o fato de a confirmação **nunca** partir do cliente.

### O risco que o cartão traz e os outros trilhos não

**Estorno (chargeback).** Cripto enviada é irreversível; cobrança no cartão
não. Um cliente pode contestar 100 BRL semanas depois de você já ter mandado o
SOL, e no cartão a presunção costuma ser a favor dele. Não existe defesa
técnica aqui — só limite de valor, limite de gente e conhecer quem paga. É o
principal motivo para `DEPOSIT_MAX_AMOUNT` continuar baixo no teste.

### O que este atalho não é

Não é conformidade. Não há KYC, nem sanções, nem limites por pessoa, nem
registro como PSP/VASP — e receber fiat de terceiros para entregar cripto é
atividade regulada na maioria das jurisdições. Serve para um teste fechado com
gente que você conhece. Antes de abrir para desconhecidos, isto vira o problema
principal, não um detalhe de deploy.

## Do zero ao primeiro cliente real

O que o código já resolve está feito. O que sobra depende de você:

**1. Fundear o vault** (o endereço aparece no painel, em Visão geral):
   - ~0,05 SOL para taxas de rede;
   - USDC como float. É ele que lastreia cada depósito em cartão e Pix: o
     cliente paga fiat na sua conta e o SOL sai deste estoque. Comece com o
     equivalente a poucos depósitos.

**2. Trocar a credencial do Mercado Pago para produção.** Com credencial de
   teste, cliente real não paga. Pegue o Access Token e a Public Key de
   produção e substitua no `.env` (ou nas variáveis do deploy).

**3. RPC dedicado.** O endpoint público da Solana tem rate limit agressivo e
   derruba swap sob carga. Helius ou QuickNode, plano gratuito serve para
   começar.

**4. `npm run preflight`** até sair sem bloqueios.

**5. Deploy** com `PUBLIC_BASE_URL` e o webhook cadastrado no painel do MP.

**6. Comece pequeno.** `DEPOSIT_MAX_AMOUNT` baixo nos primeiros dias: um
   estorno de cartão chega semanas depois do SOL já ter saído, e não existe
   defesa técnica contra isso — só limite de valor e conhecer quem paga.

## O que está verificado e o que não está

Isto importa mais que a lista de features. Estado real em 13/08/2026:

| Componente | Status |
|---|---|
| Máquina de estados, idempotência, reserva FIFO de depósito | **testado** (cenários de corrida simulados no banco) |
| Split por bps, invariante de conservação, resto para o maior bps | **testado** (incluindo valores com resto) |
| Cálculo da taxa e rateio cliente/lucro | **testado** (soma cliente+lucro === total swapado) |
| Cálculo do horário com timezone e DST | **testado** (UTC, São Paulo, Lisboa, Tóquio, virada de dia) |
| Validação HMAC, anti-replay, rejeição de payload | **testado** |
| Admin: auth, validações, edição de split e horário | **testado** |
| Jupiter `/quote` e `/swap` | **testado contra a API real** (cotação e build de tx) |
| Guarda de price impact | **testado** (12 bps @ 2M USDC, 1999 bps @ 50M — abortou) |
| **Swap executado on-chain** | **NUNCA EXECUTADO** — nenhuma tx foi transmitida, em nenhuma rede |
| **Liquidação do cliente on-chain** | **NUNCA EXECUTADA** |
| **Distribuição on-chain** | **NUNCA EXECUTADA** |
| Adapters de taxa (MoonPay/Transak/Ramp) | **NÃO VERIFICADOS** — sem chaves; ver abaixo |

Tudo que move valor de verdade continua sem exercício real. Não use com dinheiro
antes de rodar o ciclo completo em devnet.

### Adapters de taxa dos on-ramps

Vêm **desligados** por default. O que foi possível confirmar sem chaves:

| Provedor | Endpoint | Status |
|---|---|---|
| MoonPay | `GET /v3/currencies/sol/buy_quote` | Endpoint **existe** (401 com chave inválida, não 404). Formato da resposta não verificado. |
| Ramp | `POST /api/host-api/v3/onramp/quote/all` | Endpoint **existe** (400 `hostApiKey must be a string`). Formato não verificado. |
| Transak | `GET /api/v2/currencies/price` | Não probado (precisa de partner key). |
| SpherePay | — | **Não implementado**: não achei endpoint de cotação público e verificável. Deixei explícito em vez de inventar. |

Ao plugar uma chave, compare o `costBps` calculado com o extrato real do
provedor **antes** de confiar no número. Se todos falharem, a taxa cai em
`fallbackProviderCostBps` — o pagamento nunca é bloqueado por isso.

> **Jupiter:** o host clássico `quote-api.jup.ag/v6` foi **retirado do ar** (não
> resolve mais em DNS). O default agora é `lite-api.jup.ag/swap/v1`, que serve o
> mesmo contrato — verificado com cotação e build de transação reais.

## Sobre "atomicidade"

Não é implementável ponta a ponta: o fiat vive fora da chain, e swap, liquidação
e distribuição são transações Solana distintas, sem rollback conjunto. O que
existe é o equivalente prático:

| Propriedade | Como é garantida |
|---|---|
| **Idempotência na borda** | `Order.providerEventId` é `UNIQUE`. Reentrega do webhook não cria segunda ordem nem segundo swap. |
| **Durabilidade por etapa** | Cada transição é gravada **antes** da etapa seguinte. Crash retoma de onde parou. |
| **Reserva FIFO de depósito** | O saldo de USDC é um pote comum; a atribuição é por ordem de chegada. Duas ordens **nunca** gastam o mesmo depósito — foi este o bug que existia na primeira versão. |
| **Swap serializado** | Um mutex torna "verificar saldo → swapar" indivisível no processo. |
| **Split atômico** | ≤ `MAX_TRANSFERS_PER_TX` destinatários vão em **uma** transação: todos recebem ou ninguém recebe. |
| **Lucro nunca pago duas vezes** | As ordens são vinculadas ao `PayoutRun` **antes** de mover dinheiro; a partir daí saem do pool elegível. |
| **Falha parcial não redistribui** | Se um lote saiu e outro não, o run fica `PARTIAL` e é retomado — nunca reiniciado do zero. |
| **Conservação de valor** | `sum(allocations) === total`, sempre. Resto da divisão inteira para o maior bps. |

## Deploy

Ver **[DEPLOY.md](DEPLOY.md)**. A pipeline completa funciona tanto em serverless
(Vercel) quanto em host persistente (Render, Railway, Fly.io, VPS) — a exclusão
mútua vem de lock no banco, não de estruturas em memória. `vercel.json`,
`render.yaml` e `Dockerfile` estão prontos no repo.

Duas diferenças em serverless, detalhadas no DEPLOY.md: o webhook processa antes
de responder (não existe background lá), e o trabalho periódico depende de um
cron externo chamando `/admin/cron/tick` — com cron diário, uma ordem cujo
depósito aterra tarde pode esperar até 24h. Um host persistente não tem nenhuma
das duas restrições.

## Setup local

```bash
npm install
cp .env.example .env
npm run keygen          # gera VAULT_PRIVATE_KEY
npm run prisma:push     # cria o SQLite de dev
npm run dev
```

`ADMIN_API_KEY` é obrigatória (mín. 16 chars):

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

Depois abra **http://localhost:3000/admin** e cole a chave.

Simular um pagamento:

```bash
npm run sign-webhook
```

## Painel admin

`GET /admin` — página única, sem CDN, sem framework. Configura:

- **horário da distribuição** — hora, minuto e timezone IANA, com o próximo
  disparo recalculado na hora (respeita DST);
- **lucro mínimo** por execução, para não queimar fee de rede com poeira;
- **taxa** — margem, piso, teto e custo de fallback, em bps;
- **carteiras do split** — endereços e porcentagens, com a soma travada em
  10000 bps: o botão de salvar só habilita em 100% exato;
- **consulta de taxas** dos on-ramps em tempo real, com o ranking e qual foi
  eleito o melhor;
- **distribuir agora**, com opção de ignorar o mínimo;
- histórico de execuções e ordens recentes.

O `RECIPIENTS_JSON` do `.env` virou **apenas seed** da primeira subida — depois
disso a fonte de verdade é o banco.

## Endpoints

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/webhook/fiat-payment` | Webhook. `401` assinatura, `400` payload inaceitável, `200` não acionável, `202` aceito. |
| `GET` | `/quote?currency=EUR&amount=100` | **Cotação de checkout.** Devolve o on-ramp mais barato agora + taxa efetiva. É aqui que o roteamento "sempre o melhor" acontece — o frontend consulta antes de iniciar a compra. |
| `GET` | `/webhook/orders/:id` | Estado de uma ordem. |
| `GET` | `/pay` | **Checkout público** do provedor interno. Página única, sem auth. |
| `GET` | `/pay/api/options` | Trilhos habilitados, limites e taxa atual. |
| `POST` | `/pay/api/intents` | Cria a intenção. `customerWallet` é opcional — sem ela, o gateway gera uma carteira e devolve o token de posse. |
| `POST` | `/pay/api/intents/:reference/pay` | Cobra o cartão com o token do Brick. Nunca recebe número/CVV. |
| `POST` | `/pay/api/intents/:reference/wallet` | Entrega a chave privada. Exige `x-claim-token`. |
| `GET` | `/pay/api/intents/:reference` | Estado + dispara varredura on-chain e retomada da ordem. |
| `GET` | `/admin/api/deposits` | Fila de depósitos (requer chave). |
| `POST` | `/admin/api/deposits/:reference/confirm` · `/cancel` · `/scan` | Confirmar (move dinheiro), cancelar, varrer a chain. |
| `POST` | `/pay/mercadopago/webhook` | Webhook do Mercado Pago (assinado). Sempre 200 quando entendido — 5xx faria o MP desligar a integração. |
| `GET` | `/pay/mercadopago/status` | A integração está configurada? Não expõe credencial. |
| `GET` | `/admin` | Painel. |
| `GET/PUT` | `/admin/api/settings` · `/admin/api/recipients` | Config (requer chave). |
| `GET` | `/admin/api/overview` · `/api/fees` · `/api/runs` · `/api/orders` | Dados do painel. |
| `POST` | `/admin/api/distribution/run-now` | Disparo manual. |
| `GET` | `/health` · `/health/ready` · `/health/config` | Liveness · readiness · config efetiva. |

## Estrutura

```
src/
  config/index.ts                  valida TODO o .env no boot (zod)
  database/schema.prisma           Order, PayoutRun, Payout, Recipient,
                                   GatewaySettings, ProviderFeeSnapshot,
                                   DepositIntent, Lock
  services/solana.service.ts       RPC, saldos, envio com rebroadcast
  services/jupiter.service.ts      quote + swap, mede o delta real de lamports
  services/fee.service.ts          agregador de taxas dos on-ramps + taxa efetiva
  services/distribution.service.ts split por bps + SystemProgram.transfer
  services/webhook.service.ts      HMAC + normalização multi-provedor
  services/deposit.service.ts      provedor INTERNO: intenções, confirmação, câmbio
  services/deposit-watch.service.ts  varredura on-chain do trilho USDC + poll
  services/mercadopago.service.ts  trilho de cartão: preferência, consulta, webhook
  services/wallet.service.ts       carteiras geradas para o cliente (AES-256-GCM)
  services/order.service.ts        pipeline por ordem (swap + liquidação)
  services/payout.service.ts       distribuição do lucro (PayoutRun)
  services/scheduler.service.ts    horário fixo diário + varredura de pendências
  services/settings.service.ts     config no banco + cálculo de horário/timezone
  routes/{webhook,quote,admin,health,deposit}.routes.ts
  routes/admin.page.ts             painel HTML embutido
  routes/deposit.page.ts           checkout HTML embutido (/pay)
  utils/{logger,serialize,async-route}.ts
  types/index.ts                   interfaces + GatewayError (retryable)
  app.ts, server.ts
```

`utils/async-route.ts` não é decoração: o Express 4 **não** encaminha rejeições
de handlers `async` ao error middleware. Sem o wrapper, uma timezone inválida
digitada no admin derrubava o processo inteiro via `unhandledRejection` — isso
aconteceu no teste, e é o motivo de todo handler assíncrono estar envolvido.

## O que falta antes de dinheiro real

Continua valendo o que foi levantado antes, menos o que já foi corrigido.

**Corrigido nesta fase:** double-spend do depósito (reserva FIFO + mutex), teto
de price impact, teto por ordem (`MAX_ORDER_INPUT_RAW`), varredura periódica de
ordens órfãs (antes só retomava no boot), crash por erro em rota async.

**Aberto:**

1. **Rodar o ciclo completo em devnet**, várias vezes, incluindo crash proposital
   entre swap e liquidação, e entre dois lotes da distribuição.
2. **Custódia** — `VAULT_PRIVATE_KEY` em env var não serve para produção. KMS/HSM
   ou signer remoto.
3. **Confirmar cada evento na API do provedor** por `paymentId`. Hoje o HMAC é a
   única prova de que o pagamento existiu; se o segredo vazar, um evento forjado
   dispara swap e liquidação.
4. **Testes automatizados.** As verificações desta fase foram scripts descartáveis;
   `computeSplit`, `verifySignature`, `computeNextRunAt` e `committedInputRaw`
   merecem suíte fixa.
5. **Uma instância só.** `inFlight`, o mutex de swap e o guard de execução são
   in-process. Escalar horizontalmente exige lock no banco (advisory lock no
   Postgres) — com 2 réplicas, hoje, há risco de swap duplicado.
6. **Alerting.** `PARTIAL` e `NEEDS_MANUAL_REVIEW` só aparecem no painel e no log.
7. **SQLite → Postgres**, com migrations em vez de `db push`.
8. **Admin com login por pessoa.** Chave estática compartilhada não dá auditoria
   de quem mudou o split.
9. **Regulatório.** Operar on-ramp fiat, custodiar e redistribuir fundos de
   terceiros é atividade regulada na maioria das jurisdições (KYC/AML, licença de
   pagamentos). A parte técnica está aqui; a habilitação legal não.
