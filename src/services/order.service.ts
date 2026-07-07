import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/connection';
import { Campaign, DeliveryWebhookPayload, Order } from '../types';
import { ledgerService } from './ledger.service';

const ESCROW_RELEASE_DAYS = 7;

/**
 * OrderService
 *
 * Handles upfront order creation, escrow management,
 * delivery webhook processing, and dispatch triggering.
 */
export class OrderService {
  /**
   * Create a new order with 100% upfront payment.
   * Escrow is set to 'holding' until delivery is confirmed.
   */
  async createOrder(params: {
    campaignId: string;
    customerName: string;
    customerPhone: string;
    shippingAddress: string;
    amountPaid: number;
  }): Promise<Order> {
    const { campaignId, customerName, customerPhone, shippingAddress, amountPaid } = params;

    // Validate campaign is active
    const campaignResult = await pool.query<Campaign>(
      `SELECT * FROM campaigns WHERE id = $1 AND is_active = TRUE AND status = 'active'`,
      [campaignId],
    );
    if (campaignResult.rows.length === 0) {
      throw new Error(`Campaign ${campaignId} is not active`);
    }

    const campaign = campaignResult.rows[0];

    // Validate product stock and price
    const productResult = await pool.query(
      `SELECT p.*, u.id AS prompter_user_id
         FROM products p
         JOIN users u ON u.id = p.prompter_id
        WHERE p.id = $1 AND p.stock_quantity > 0`,
      [campaign.product_id],
    );
    if (productResult.rows.length === 0) {
      throw new Error(`Product not available or out of stock`);
    }

    const product = productResult.rows[0];
    if (amountPaid < product.retail_price) {
      throw new Error(
        `Amount paid (${amountPaid}) is less than retail price (${product.retail_price})`,
      );
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Decrement stock atomically
      const stockUpdate = await client.query(
        `UPDATE products
            SET stock_quantity = stock_quantity - 1
          WHERE id = $1 AND stock_quantity > 0
          RETURNING stock_quantity`,
        [product.id],
      );
      if (stockUpdate.rowCount === 0) {
        throw new Error(`Product out of stock`);
      }

      // Create order
      const orderId = uuidv4();
      const orderResult = await client.query<Order>(
        `INSERT INTO orders
           (id, campaign_id, customer_name, customer_phone, shipping_address, amount_paid)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [orderId, campaignId, customerName, customerPhone, shippingAddress, amountPaid],
      );
      const order = orderResult.rows[0];

      await client.query('COMMIT');
      return order;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Mark an order as paid and initiate the revenue split.
   * Called after payment gateway confirmation.
   */
  async markOrderPaid(orderId: string, adCostPerPurchase: number): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Load order, campaign, and product
      const result = await client.query(
        `SELECT o.*, c.product_id, c.creator_id,
                p.floor_price, p.backer_buyin_threshold, p.retail_price, p.prompter_id
           FROM orders o
           JOIN campaigns c ON c.id = o.campaign_id
           JOIN products p ON p.id = c.product_id
          WHERE o.id = $1
            AND o.escrow_status = 'holding'`,
        [orderId],
      );
      if (result.rows.length === 0) {
        throw new Error(`Order ${orderId} not found or already processed`);
      }

      const row = result.rows[0];

      // Calculate revenue splits
      const split = ledgerService.calculateRevenueSplit(
        Number(row.retail_price),
        Number(row.floor_price),
        Number(row.backer_buyin_threshold),
        adCostPerPurchase,
      );

      // Load backers for this campaign and calculate proportional splits
      const backerResult = await client.query<{
        backer_id: string;
        backer_share_percentage: number;
      }>(
        `SELECT backer_id, backer_share_percentage
           FROM ad_pools
          WHERE campaign_id = $1`,
        [row.campaign_id],
      );

      const totalSharePct = backerResult.rows.reduce(
        (sum, b) => sum + Number(b.backer_share_percentage),
        0,
      );

      const backerEntries = backerResult.rows.map((b) => ({
        backerId: b.backer_id,
        amount:
          totalSharePct > 0
            ? (Number(b.backer_share_percentage) / totalSharePct) * split.backer_split
            : 0,
      }));

      await client.query('COMMIT');
      client.release();

      // Record splits outside of this transaction (ledger service manages its own transaction)
      const PLATFORM_USER_ID = process.env.PLATFORM_USER_ID || '';
      await ledgerService.recordOrderPaidSplits(
        orderId,
        row.prompter_id,
        PLATFORM_USER_ID,
        backerEntries,
        split,
      );
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
      throw err;
    }
  }

  /**
   * Trigger dispatch: generate a shipping label and update order status.
   * Fires a pickup manifest to the logistics partner (e.g. Viettel Post).
   */
  async triggerDispatch(orderId: string, trackingCode: string): Promise<Order> {
    const result = await pool.query<Order>(
      `UPDATE orders
          SET tracking_code = $1,
              delivery_status = 'dispatched'
        WHERE id = $2
          AND delivery_status = 'pending'
        RETURNING *`,
      [trackingCode, orderId],
    );
    if (result.rowCount === 0) {
      throw new Error(`Order ${orderId} cannot be dispatched`);
    }
    return result.rows[0];
  }

  /**
   * Handle a delivery webhook from a courier partner.
   * Updates order status and triggers accounting routines.
   */
  async handleDeliveryWebhook(payload: DeliveryWebhookPayload): Promise<void> {
    const { tracking_code, delivery_status } = payload;

    const orderResult = await pool.query<Order>(
      `SELECT o.*, c.product_id, c.id AS campaign_id_ref
         FROM orders o
         JOIN campaigns c ON c.id = o.campaign_id
        WHERE o.tracking_code = $1`,
      [tracking_code],
    );
    if (orderResult.rows.length === 0) {
      throw new Error(`No order found for tracking code: ${tracking_code}`);
    }
    const order = orderResult.rows[0];

    // Update delivery status
    await pool.query(
      `UPDATE orders SET delivery_status = $1 WHERE id = $2`,
      [delivery_status, order.id],
    );

    if (delivery_status === 'delivered') {
      // Schedule the 7-day escrow release
      await this.scheduleEscrowRelease(order.id, ESCROW_RELEASE_DAYS);
    } else if (
      delivery_status === 'failed' ||
      delivery_status === 'returned_to_sender'
    ) {
      await this.handleFailedDelivery(order);
    }
  }

  /**
   * Schedule escrow release after the safety buffer window elapses.
   * In production this would enqueue a delayed job via Kafka.
   * Here we use a simple setTimeout for demonstration.
   */
  async scheduleEscrowRelease(orderId: string, delayDays: number): Promise<void> {
    const delayMs = delayDays * 24 * 60 * 60 * 1000;
    setTimeout(() => {
      this.releaseEscrow(orderId).catch((err) => {
        console.error(`Failed to release escrow for order ${orderId}:`, err);
      });
    }, delayMs);
  }

  /**
   * Release all pending_escrow funds to available balances for an order.
   */
  async releaseEscrow(orderId: string): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Mark escrow as released
      const updateResult = await client.query(
        `UPDATE orders
            SET escrow_status = 'released'
          WHERE id = $1
            AND escrow_status = 'holding'
          RETURNING *`,
        [orderId],
      );
      if (updateResult.rowCount === 0) {
        // Already released or voided
        await client.query('ROLLBACK');
        return;
      }

      // Fetch all pending escrow ledger entries for this order
      const ledgerResult = await client.query<{
        user_id: string;
        amount: number;
      }>(
        `SELECT user_id,
                SUM(CASE WHEN direction = 'debit' THEN amount ELSE -amount END) AS amount
           FROM ledger_transactions
          WHERE order_id = $1
            AND balance_type = 'pending_escrow'
          GROUP BY user_id
         HAVING SUM(CASE WHEN direction = 'debit' THEN amount ELSE -amount END) > 0`,
        [orderId],
      );

      await client.query('COMMIT');
      client.release();

      // Release each user's escrow outside of the above transaction
      for (const row of ledgerResult.rows) {
        await ledgerService.releaseEscrowToAvailable(
          orderId,
          row.user_id,
          Number(row.amount),
        );
      }
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
      throw err;
    }
  }

  /**
   * Handle failed delivery or return-to-sender:
   * - Issue full customer refund
   * - Void pending splits
   * - Apply return shipping penalty to prompter's escrow
   */
  private async handleFailedDelivery(order: Order): Promise<void> {
    const RETURN_SHIPPING_PENALTY = Number(
      process.env.RETURN_SHIPPING_PENALTY_VND || '30000',
    );

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Void the order's escrow
      await client.query(
        `UPDATE orders
            SET escrow_status = 'voided',
                refund_requested = TRUE
          WHERE id = $1`,
        [order.id],
      );

      // Load prompter for this order's product
      const prompterResult = await client.query<{ prompter_id: string }>(
        `SELECT p.prompter_id
           FROM orders o
           JOIN campaigns c ON c.id = o.campaign_id
           JOIN products p ON p.id = c.product_id
          WHERE o.id = $1`,
        [order.id],
      );

      // Load backers
      const backerResult = await client.query<{ backer_id: string }>(
        `SELECT ap.backer_id
           FROM orders o
           JOIN ad_pools ap ON ap.campaign_id = o.campaign_id
          WHERE o.id = $1`,
        [order.id],
      );

      await client.query('COMMIT');
      client.release();

      if (prompterResult.rows.length > 0) {
        const prompterId = prompterResult.rows[0].prompter_id;
        const backerIds = backerResult.rows.map((r) => r.backer_id);

        await ledgerService.voidSplitsAndApplyReturnPenalty(
          order.id,
          prompterId,
          backerIds,
          RETURN_SHIPPING_PENALTY,
        );
      }
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
      throw err;
    }
  }

  /**
   * Get all orders for the Quest Log dispatch view.
   */
  async getDispatchQueue(): Promise<Order[]> {
    const result = await pool.query<Order>(
      `SELECT * FROM orders WHERE delivery_status = 'pending' ORDER BY created_at ASC`,
    );
    return result.rows;
  }
}

export const orderService = new OrderService();
