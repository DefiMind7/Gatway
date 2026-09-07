#!/usr/bin/env node
/**
 * Coloca as lojas antigas no estado certo depois da migração de contas.
 *
 *   npm run db:backfill
 *
 * Por que isto existe: `Merchant.status` nasceu com default "sem_pedido", e é
 * o valor que TODA linha já existente recebeu quando a coluna foi criada. Mas
 * `authenticateMerchant` passou a exigir "aprovado" — sem este passo, lojas
 * que já cobravam ontem param de cobrar hoje, com 401 e nenhuma explicação.
 *
 * A regra é simples e verificável: quem já tem chave de API emitida já foi
 * aprovado por alguém, um dia. É o único sinal confiável que o banco antigo
 * guarda, e é suficiente.
 *
 * Idempotente: rodar duas vezes não muda nada na segunda.
 */
const { PrismaClient } = require('@prisma/client');

async function main() {
  const prisma = new PrismaClient();
  try {
    const { count } = await prisma.merchant.updateMany({
      where: { apiKeyHash: { not: null }, status: 'sem_pedido' },
      data: { status: 'aprovado' },
    });

    // Pedidos antigos que foram aprovados no modelo anterior: a loja nasceu na
    // aprovação, então o merchantId do pedido aponta para ela.
    const aprovados = await prisma.merchantApplication.findMany({
      where: { status: 'aprovado', merchantId: { not: null } },
      select: { merchantId: true },
    });
    let pedidos = 0;
    for (const p of aprovados) {
      const r = await prisma.merchant.updateMany({
        where: { id: p.merchantId, status: 'sem_pedido' },
        data: { status: 'aprovado' },
      });
      pedidos += r.count;
    }

    const total = await prisma.merchant.count();
    const semPedido = await prisma.merchant.count({ where: { status: 'sem_pedido' } });

    console.log(`lojas com chave promovidas a aprovado: ${count}`);
    console.log(`lojas promovidas por pedido já aprovado: ${pedidos}`);
    console.log(`total de lojas: ${total} | ainda sem pedido: ${semPedido}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
