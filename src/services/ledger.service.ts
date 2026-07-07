import { PoolClient } from 'pg';
import {
  BalanceType,
  LedgerTransaction,
  RevenueSplit,
  TransactionDirection,
  VaultBalance,
} from '../types';
import { pool } from '../db/connection';

/**
 * LedgerService
 *
 * Implements the double-entry accounting ledger for HypeStack.
 * Handles revenue routing, split calculations, escrow management,
 * and balance queries per the Vault architecture.
 */
export class LedgerService {
  /**
   * Calculate the tiered revenue split for a given order.
   *
   * Revenue nodes:
   *   - Gross Revenue = amount paid by customer (retail_price)
   *   - Floor Cost    = prompter floor_price (manufacturing + platform fee)
   *   - Upper Delta   = Gross Revenue - Backer Buy-in Threshold
   *   - Prompter Delta = Backer Buy-in Threshold - Floor Cost
   *   - Platform Split = collected from Floor Cost
   *   - Prompter Cut  = Prompter Delta (fixed passive compensation)
   *   - Backer Split  = Upper Delta - ad_cost_per_purchase
   */
  calculateRevenueSplit(
    grossRevenue: number,
    floorCost: number,
    backerBuyinThreshold: number,
    adCostPerPurchase: number,
  ): RevenueSplit {
    const upperDelta = grossRevenue - backerBuyinThreshold;
    const prompterDelta = backerBuyinThreshold - floorCost;
    const backerSplit = upperDelta - adCostPerPurchase;

    return {
      gross_revenue: grossRevenue,
      floor_cost: floorCost,
      backer_buyin_threshold: backerBuyinThreshold,
      upper_delta: upperDelta,
      prompter_delta: prompterDelta,
      platform_split: floorCost,
      prompter_cut: prompterDelta,
      backer_split: backerSplit,
      ad_cost_per_purchase: adCostPerPurchase,
    };
  }

  /**
   * Record a ledger entry within an existing transaction client.
   */
  async recordEntry(
    client: PoolClient,
    userId: string,
    orderId: string | null,
    amount: number,
    balanceType: BalanceType,
    direction: TransactionDirection,
    description: string,
  ): Promise<LedgerTransaction> {
    const result = await client.query<LedgerTransaction>(
      `INSERT INTO ledger_transactions
         (user_id, order_id, amount, balance_type, direction, description)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [userId, orderId, amount, balanceType, direction, description],
    );
    return result.rows[0];
  }

  /**
   * Write all split entries to the ledger when an order is marked paid.
   * Entries are written as pending_escrow for prompter and backers,
   * and directly to platform_pool for the platform cut.
   *
   * @param orderId     - The order being settled
   * @param prompterId  - User receiving the prompter cut
   * @param platformId  - Platform account user ID
   * @param backerEntries - Array of { backerId, amount } for each backer's share
   * @param split       - Calculated revenue split
   */
  async recordOrderPaidSplits(
    orderId: string,
    prompterId: string,
    platformId: string,
    backerEntries: Array<{ backerId: string; amount: number }>,
    split: RevenueSplit,
  ): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Platform cut → platform_pool (direct, not escrowed)
      await this.recordEntry(
        client,
        platformId,
        orderId,
        split.platform_split,
        'platform_pool',
        'debit',
        `Platform fee for order ${orderId}`,
      );

      // Prompter cut → pending_escrow (released after delivery + 7-day buffer)
      if (split.prompter_cut > 0) {
        await this.recordEntry(
          client,
          prompterId,
          orderId,
          split.prompter_cut,
          'pending_escrow',
          'debit',
          `Prompter cut pending escrow for order ${orderId}`,
        );
      }

      // Backer splits → pending_escrow
      for (const entry of backerEntries) {
        if (entry.amount > 0) {
          await this.recordEntry(
            client,
            entry.backerId,
            orderId,
            entry.amount,
            'pending_escrow',
            'debit',
            `Backer split pending escrow for order ${orderId}`,
          );
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Release escrow funds to available balance after successful delivery
   * and the 7-day safety buffer has elapsed.
   */
  async releaseEscrowToAvailable(
    orderId: string,
    userId: string,
    amount: number,
  ): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Offset the pending_escrow debit with a credit (release)
      await this.recordEntry(
        client,
        userId,
        orderId,
        amount,
        'pending_escrow',
        'credit',
        `Escrow released to available for order ${orderId}`,
      );

      // Credit the available balance
      await this.recordEntry(
        client,
        userId,
        orderId,
        amount,
        'available',
        'debit',
        `Funds available after escrow release for order ${orderId}`,
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Void all pending split entries for a failed/returned order and
   * apply a return shipping penalty directly against the prompter's
   * pending_escrow balance.
   *
   * This routine isolates negative balance risk to the prompter's escrow layer.
   */
  async voidSplitsAndApplyReturnPenalty(
    orderId: string,
    prompterId: string,
    backerIds: string[],
    returnShippingPenalty: number,
  ): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Void prompter pending escrow (reverse the debit with a credit)
      const prompterEscrow = await client.query<{ amount: number }>(
        `SELECT COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount ELSE -amount END), 0) AS amount
           FROM ledger_transactions
          WHERE order_id = $1
            AND user_id = $2
            AND balance_type = 'pending_escrow'`,
        [orderId, prompterId],
      );
      const prompterPending = Number(prompterEscrow.rows[0].amount);
      if (prompterPending > 0) {
        await this.recordEntry(
          client,
          prompterId,
          orderId,
          prompterPending,
          'pending_escrow',
          'credit',
          `Void prompter escrow for failed/returned order ${orderId}`,
        );
      }

      // Void backer pending escrow entries
      for (const backerId of backerIds) {
        const backerEscrow = await client.query<{ amount: number }>(
          `SELECT COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount ELSE -amount END), 0) AS amount
             FROM ledger_transactions
            WHERE order_id = $1
              AND user_id = $2
              AND balance_type = 'pending_escrow'`,
          [orderId, backerId],
        );
        const backerPending = Number(backerEscrow.rows[0].amount);
        if (backerPending > 0) {
          await this.recordEntry(
            client,
            backerId,
            orderId,
            backerPending,
            'pending_escrow',
            'credit',
            `Void backer escrow for failed/returned order ${orderId}`,
          );
        }
      }

      // Apply return shipping penalty as a credit deduction against prompter's escrow
      if (returnShippingPenalty > 0) {
        await this.recordEntry(
          client,
          prompterId,
          orderId,
          returnShippingPenalty,
          'pending_escrow',
          'credit',
          `Return shipping penalty for order ${orderId}`,
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Get the current Vault balance summary for a user.
   * Balances are computed from the ledger: debit increases, credit decreases.
   */
  async getVaultBalance(userId: string): Promise<VaultBalance> {
    const result = await pool.query<{
      balance_type: BalanceType;
      balance: number;
    }>(
      `SELECT
         balance_type,
         SUM(CASE WHEN direction = 'debit' THEN amount ELSE -amount END) AS balance
       FROM ledger_transactions
       WHERE user_id = $1
         AND balance_type IN ('available', 'pending_escrow', 'active_ad_float')
       GROUP BY balance_type`,
      [userId],
    );

    const balances: VaultBalance = {
      user_id: userId,
      available: 0,
      pending_escrow: 0,
      active_ad_float: 0,
    };

    for (const row of result.rows) {
      const b = Number(row.balance);
      switch (row.balance_type) {
        case 'available':
          balances.available = b;
          break;
        case 'pending_escrow':
          balances.pending_escrow = b;
          break;
        case 'active_ad_float':
          balances.active_ad_float = b;
          break;
      }
    }

    return balances;
  }

  /**
   * Credit the active_ad_float when a backer stacks capital into a campaign.
   */
  async recordAdFloat(
    backerId: string,
    campaignId: string,
    amount: number,
  ): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await this.recordEntry(
        client,
        backerId,
        null,
        amount,
        'active_ad_float',
        'debit',
        `Ad float stacked for campaign ${campaignId}`,
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

export const ledgerService = new LedgerService();
