import { Router, Request, Response } from 'express';
import { orderService } from '../services/order.service';
import { DeliveryWebhookPayload } from '../types';

const router = Router();

/**
 * GET /api/quest
 * Returns the Quest Log dispatch queue (orders pending dispatch).
 */
router.get('/', async (_req: Request, res: Response) => {
  try {
    const queue = await orderService.getDispatchQueue();
    res.json({ data: queue });
  } catch (err) {
    console.error('[Quest] Dispatch queue error:', err);
    res.status(500).json({ error: 'Failed to load dispatch queue' });
  }
});

/**
 * POST /api/quest/order
 * Customer places an order (100% upfront payment required).
 *
 * Body: { campaignId, customerName, customerPhone, shippingAddress, amountPaid }
 */
router.post('/order', async (req: Request, res: Response) => {
  try {
    const { campaignId, customerName, customerPhone, shippingAddress, amountPaid } =
      req.body as {
        campaignId: string;
        customerName: string;
        customerPhone: string;
        shippingAddress: string;
        amountPaid: number;
      };

    if (!campaignId || !customerName || !customerPhone || !shippingAddress || !amountPaid) {
      res.status(400).json({ error: 'All order fields are required' });
      return;
    }

    const order = await orderService.createOrder({
      campaignId,
      customerName,
      customerPhone,
      shippingAddress,
      amountPaid: Number(amountPaid),
    });

    res.status(201).json({ data: order });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create order';
    res.status(400).json({ error: message });
  }
});

/**
 * POST /api/quest/order/:id/dispatch
 * Trigger dispatch: generate shipping label and notify logistics partner.
 *
 * Body: { trackingCode }
 */
router.post('/order/:id/dispatch', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { trackingCode } = req.body as { trackingCode: string };

    if (!trackingCode) {
      res.status(400).json({ error: 'trackingCode is required' });
      return;
    }

    const order = await orderService.triggerDispatch(id, trackingCode);
    res.json({ data: order });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to trigger dispatch';
    res.status(400).json({ error: message });
  }
});

/**
 * POST /api/quest/webhook/delivery
 * Receive delivery status webhooks from courier partners (e.g. Viettel Post).
 *
 * Body: DeliveryWebhookPayload
 */
router.post('/webhook/delivery', async (req: Request, res: Response) => {
  try {
    const payload = req.body as DeliveryWebhookPayload;

    if (!payload.tracking_code || !payload.delivery_status) {
      res.status(400).json({ error: 'tracking_code and delivery_status are required' });
      return;
    }

    await orderService.handleDeliveryWebhook(payload);
    res.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to process webhook';
    res.status(400).json({ error: message });
  }
});

export { router as questRouter };
