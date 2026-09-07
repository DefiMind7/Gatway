import type { MerchantNotification } from '@prisma/client';
import { prisma } from '../database/client';

/**
 * Avisos da gateway para a loja.
 *
 * Módulo próprio, e não uma função dentro da conta, porque quem avisa não é só
 * a conta: o livro-razão avisa quando um saque sai, a análise avisa quando o
 * pedido é decidido. Deixar `notify` na conta faria o razão importar a conta
 * que importa o razão — ciclo que o TypeScript tolera e o runtime nem sempre.
 */

export const NotificationKind = {
  APROVADO: 'aprovado',
  RECUSADO: 'recusado',
  CHAVE: 'chave',
  SENHA: 'senha',
  SAQUE: 'saque',
  AVISO: 'aviso',
} as const;

/**
 * O canal de aviso da gateway para a loja.
 *
 * Um aviso não é um log: ele existe para ser lido por uma pessoa que talvez só
 * abra o painel semana que vem. Por isso fica no banco, com estado de lido, em
 * vez de virar mensagem que passa.
 */
export async function notify(
  merchantId: string,
  kind: string,
  title: string,
  body?: string,
  link?: string,
): Promise<MerchantNotification> {
  return prisma.merchantNotification.create({
    data: {
      merchantId,
      kind,
      title: title.slice(0, 160),
      body: body?.slice(0, 800) ?? null,
      link: link ?? null,
    },
  });
}

export interface NotificationView {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  read: boolean;
  createdAt: string;
}

export async function listNotifications(
  merchantId: string,
  limit = 30,
): Promise<NotificationView[]> {
  const avisos = await prisma.merchantNotification.findMany({
    where: { merchantId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  return avisos.map((a) => ({
    id: a.id,
    kind: a.kind,
    title: a.title,
    body: a.body,
    link: a.link,
    read: a.readAt !== null,
    createdAt: a.createdAt.toISOString(),
  }));
}

export async function markNotificationsRead(merchantId: string, id?: string): Promise<void> {
  await prisma.merchantNotification.updateMany({
    where: { merchantId, readAt: null, ...(id ? { id } : {}) },
    data: { readAt: new Date() },
  });
}
