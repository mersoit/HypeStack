import { pool } from '../db/connection';
import { campaignService } from '../services/campaign.service';

/**
 * BudgetMonitorWorker
 *
 * High-frequency background worker that prevents unauthorized budget overruns.
 * Runs continuously, querying active campaigns and pausing any ad sets
 * where the backer funding pool has dropped below the safety threshold
 * of 50,000 VND.
 *
 * Per spec: "a high-frequency background worker runs continuously. The service
 * opens a database context, queries active campaigns, and isolates any ad sets
 * where user funding reserves have dropped below a safety threshold of fifty
 * thousand Vietnamese Dong."
 */
export class BudgetMonitorWorker {
  private static readonly SAFETY_THRESHOLD_VND = 50_000;
  private static readonly POLL_INTERVAL_MS = 10_000; // 10 seconds

  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  start(): void {
    console.log('[BudgetMonitor] Starting budget monitor worker...');
    this.intervalHandle = setInterval(
      () => this.runCheck().catch((err) => console.error('[BudgetMonitor] Error:', err)),
      BudgetMonitorWorker.POLL_INTERVAL_MS,
    );
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      console.log('[BudgetMonitor] Stopped.');
    }
  }

  /**
   * Single execution cycle:
   * 1. Query active campaigns
   * 2. Check total remaining_budget per campaign
   * 3. Pause any that are below the safety threshold
   */
  async runCheck(): Promise<number> {
    const result = await pool.query<{
      campaign_id: string;
      total_remaining: number;
    }>(
      `SELECT ap.campaign_id,
              COALESCE(SUM(ap.remaining_budget), 0) AS total_remaining
         FROM ad_pools ap
         JOIN campaigns c ON c.id = ap.campaign_id
        WHERE c.is_active = TRUE
          AND c.status = 'active'
        GROUP BY ap.campaign_id
       HAVING COALESCE(SUM(ap.remaining_budget), 0) < $1`,
      [BudgetMonitorWorker.SAFETY_THRESHOLD_VND],
    );

    let pausedCount = 0;
    for (const row of result.rows) {
      console.log(
        `[BudgetMonitor] Pausing campaign ${row.campaign_id} — remaining budget: ${row.total_remaining} VND`,
      );
      await campaignService.pauseCampaign(row.campaign_id, 'paused_out_of_funds');
      pausedCount++;
    }

    return pausedCount;
  }
}

export const budgetMonitorWorker = new BudgetMonitorWorker();
