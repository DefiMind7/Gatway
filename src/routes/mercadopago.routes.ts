import { Router, type Request, type Response } from 'express';
import { config } from '../config';
import { logger } from '../utils/logger';
import { confirmFromPsp } from '../services/deposit.service';
import {
  extractPaymentId,
  getPayment,
  isConfigured,
  verifyWebhookSignature,
} from '../services/mercadopago.service';
import { ah } from '../utils/async-route';

/**
 * Webhook do Mercado Pago.
 *
 * Contrato de resposta, deliberado: **sempre 200 quando a mensagem foi
 * entendida**, mesmo que nada tenha sido feito. O MP reentrega em qualquer
 * resposta que não seja 2xx e desativa a integração depois de muitas falhas —
 * um 500 por um pagamento recusado (que nunca vai ser aprovado) derrubaria o
 * webhook inteiro.
 *
 * O corpo do webhook é tratado como **notificação, não como fato**: ele traz
 * só um id, e o estado do dinheiro vem sempre de uma consulta à API do MP com
 * a nossa credencial. Por isso uma requisição forjada, no pior caso, gasta uma
 * consulta — não confirma pagamento nenhum.
 */

const router: Router = Router();
const log = logger.child({ scope: 'mercadopago.webhook' });

router.all('/webhook', ah(async (req: Request, res: Response) => {
  if (!isConfigured()) {
    return res.status(503).json({ error: 'psp_not_configured' });
  }

  const { id, topic } = extractPaymentId(req);

  // O MP manda notificações de vários tópicos (merchant_order, plan...).
  // Só `payment` interessa aqui.
  if (!topic.includes('payment')) {
    return res.status(200).json({ received: true, acted: false, reason: `topic=${topic}` });
  }
  if (id === null) {
    log.warn({ body: req.body, query: req.query }, 'webhook do MP sem id de pagamento');
    return res.status(200).json({ received: true, acted: false, reason: 'sem id' });
  }

  const verification = verifyWebhookSignature(req, id);
  if (!verification.valid) {
    log.warn({ reason: verification.reason, ip: req.ip }, 'webhook do MP rejeitado');
    return res.status(401).json({ error: 'invalid_signature', message: verification.reason });
  }

  const payment = await getPayment(id);
  if (payment.externalReference === null) {
    log.warn({ paymentId: id }, 'pagamento sem external_reference — não dá para ligar a uma intenção');
    return res.status(200).json({ received: true, acted: false, reason: 'sem external_reference' });
  }
  if (!payment.approved) {
    log.info(
      { paymentId: id, status: payment.status, reference: payment.externalReference },
      'pagamento ainda não aprovado',
    );
    return res.status(200).json({ received: true, acted: false, status: payment.status });
  }

  try {
    const result = await confirmFromPsp(payment.externalReference, payment);
    return res.status(200).json({
      received: true,
      acted: true,
      reference: payment.externalReference,
      orderId: result.orderId,
      duplicate: !result.created,
    });
  } catch (err) {
    // Já confirmado, valor divergente, intenção inexistente: nada disso melhora
    // com reentrega. Responder 200 evita que o MP desligue o webhook por causa
    // de um caso que é para o operador resolver no painel.
    const message = err instanceof Error ? err.message : String(err);
    log.error({ paymentId: id, reference: payment.externalReference, err: message }, 'falha ao confirmar pagamento do MP');
    return res.status(200).json({ received: true, acted: false, error: message });
  }
}));

/** Diagnóstico: a integração está configurada? (não expõe a credencial) */
router.get('/status', (_req: Request, res: Response) => {
  res.json({
    configured: isConfigured(),
    sandbox: config.mercadopago.sandbox,
    webhookSigned: config.mercadopago.webhookSecret.length > 0,
    publicBaseUrl: config.mercadopago.publicBaseUrl || null,
    webhookUrl: config.mercadopago.publicBaseUrl
      ? `${config.mercadopago.publicBaseUrl.replace(/\/+$/, '')}/pay/mercadopago/webhook`
      : null,
  });
});

export default router;
