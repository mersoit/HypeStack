import { pool } from '../db/connection';
import { orderService } from '../services/order.service';

/**
 * EscrowReleaseWorker
 *
 * Background worker that polls for orders where:
 * - delivery_status = 'delivered'
 * - escrow_status = 'holding'
 * - The 7-day safety buffer has elapsed since delivery was confirmed
 *
 * When found, it triggers the escrow release to move funds to
 * participants' Available balances.
 */
export class EscrowReleaseWorker {
  private static readonly ESCROW_HOLD_DAYS = 7;
  private static readonly POLL_INTERVAL_MS = 60_000; // 1 minute

  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  start(): void {
    console.log('[EscrowRelease] Starting escrow release worker...');
    this.intervalHandle = setInterval(
      () =>
        this.runCheck().catch((err) =>
          console.error('[EscrowRelease] Error:', err),
        ),
      EscrowReleaseWorker.POLL_INTERVAL_MS,
    );
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      console.log('[EscrowRelease] Stopped.');
    }
  }

  /**
   * Find all orders eligible for escrow release and process them.
   */
  async runCheck(): Promise<number> {
    const holdDays = EscrowReleaseWorker.ESCROW_HOLD_DAYS;

    const result = await pool.query<{ id: string }>(
      `SELECT o.id
         FROM orders o
        WHERE o.delivery_status = 'delivered'
          AND o.escrow_status = 'holding'
          AND o.created_at < NOW() - INTERVAL '${holdDays} days'`,
    );

    let releasedCount = 0;
    for (const row of result.rows) {
      console.log(`[EscrowRelease] Releasing escrow for order ${row.id}`);
      await orderService.releaseEscrow(row.id);
      releasedCount++;
    }

    return releasedCount;
  }
}

export const escrowReleaseWorker = new EscrowReleaseWorker();
