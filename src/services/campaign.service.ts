import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/connection';
import { AdPool, ArenaItem, Campaign } from '../types';

/**
 * CampaignService
 *
 * Manages campaign lifecycle, hype score updates,
 * ad pool (backer stacking), and the Arena discovery feed.
 */
export class CampaignService {
  /**
   * Create a new campaign for a product.
   */
  async createCampaign(params: {
    productId: string;
    creatorId: string;
    audienceParams?: string;
  }): Promise<Campaign> {
    const { productId, creatorId, audienceParams } = params;

    // Verify the creator is KYC-verified
    const userResult = await pool.query(
      `SELECT id, national_id_verified FROM users WHERE id = $1`,
      [creatorId],
    );
    if (userResult.rows.length === 0) {
      throw new Error(`User ${creatorId} not found`);
    }
    if (!userResult.rows[0].national_id_verified) {
      throw new Error(
        `User ${creatorId} must complete identity verification before creating campaigns`,
      );
    }

    const campaignId = uuidv4();
    const result = await pool.query<Campaign>(
      `INSERT INTO campaigns
         (id, product_id, creator_id, audience_params, status)
       VALUES ($1, $2, $3, $4, 'pending')
       RETURNING *`,
      [campaignId, productId, creatorId, audienceParams || null],
    );
    return result.rows[0];
  }

  /**
   * Update campaign with generated ad assets from the AI pipeline.
   */
  async setAdAssets(
    campaignId: string,
    assets: {
      adSetId: string;
      adVideoUrl: string;
      landingPageUrl: string;
    },
  ): Promise<Campaign> {
    const result = await pool.query<Campaign>(
      `UPDATE campaigns
          SET ad_set_id = $1,
              ad_video_url = $2,
              landing_page_url = $3,
              status = 'active',
              is_active = TRUE
        WHERE id = $4
        RETURNING *`,
      [assets.adSetId, assets.adVideoUrl, assets.landingPageUrl, campaignId],
    );
    if (result.rowCount === 0) {
      throw new Error(`Campaign ${campaignId} not found`);
    }
    return result.rows[0];
  }

  /**
   * Backer stacks capital into a campaign ad pool.
   * Returns the updated or created AdPool record.
   */
  async stackIn(params: {
    campaignId: string;
    backerId: string;
    amount: number;
  }): Promise<AdPool> {
    const { campaignId, backerId, amount } = params;

    if (amount <= 0) {
      throw new Error('Stack amount must be greater than zero');
    }

    // Verify backer is KYC verified
    const userResult = await pool.query(
      `SELECT id, national_id_verified FROM users WHERE id = $1`,
      [backerId],
    );
    if (userResult.rows.length === 0) {
      throw new Error(`User ${backerId} not found`);
    }
    if (!userResult.rows[0].national_id_verified) {
      throw new Error(
        `User ${backerId} must complete identity verification before backing campaigns`,
      );
    }

    // Verify campaign is active
    const campaignResult = await pool.query<Campaign>(
      `SELECT * FROM campaigns WHERE id = $1 AND is_active = TRUE`,
      [campaignId],
    );
    if (campaignResult.rows.length === 0) {
      throw new Error(`Campaign ${campaignId} is not active`);
    }

    // Get product's min backer buy-in threshold
    const productResult = await pool.query<{ backer_buyin_threshold: number }>(
      `SELECT p.backer_buyin_threshold
         FROM campaigns c
         JOIN products p ON p.id = c.product_id
        WHERE c.id = $1`,
      [campaignId],
    );
    const minBuyin = Number(productResult.rows[0].backer_buyin_threshold);
    if (amount < minBuyin) {
      throw new Error(
        `Minimum stack amount is ${minBuyin} for this campaign`,
      );
    }

    // Get total existing pool for share calculation
    const totalPoolResult = await pool.query<{ total: number }>(
      `SELECT COALESCE(SUM(total_allocated_budget), 0) AS total
         FROM ad_pools WHERE campaign_id = $1`,
      [campaignId],
    );
    const existingTotal = Number(totalPoolResult.rows[0].total);
    const newTotal = existingTotal + amount;

    // Calculate this backer's share percentage of the total pool
    const sharePercentage = (amount / newTotal) * 100;

    // Recalculate existing backers' share percentages proportionally
    await pool.query(
      `UPDATE ad_pools
          SET backer_share_percentage = (total_allocated_budget / $1) * 100
        WHERE campaign_id = $2`,
      [newTotal, campaignId],
    );

    // Insert or update this backer's pool entry
    const existingPool = await pool.query<AdPool>(
      `SELECT * FROM ad_pools WHERE campaign_id = $1 AND backer_id = $2`,
      [campaignId, backerId],
    );

    let adPool: AdPool;
    if (existingPool.rows.length > 0) {
      const current = existingPool.rows[0];
      const updatedTotal = Number(current.total_allocated_budget) + amount;
      const updatedShare = (updatedTotal / newTotal) * 100;
      const updateResult = await pool.query<AdPool>(
        `UPDATE ad_pools
            SET total_allocated_budget = total_allocated_budget + $1,
                remaining_budget = remaining_budget + $1,
                backer_share_percentage = $2
          WHERE id = $3
          RETURNING *`,
        [amount, updatedShare, current.id],
      );
      adPool = updateResult.rows[0];
    } else {
      const insertResult = await pool.query<AdPool>(
        `INSERT INTO ad_pools
           (campaign_id, backer_id, total_allocated_budget, remaining_budget, backer_share_percentage)
         VALUES ($1, $2, $3, $3, $4)
         RETURNING *`,
        [campaignId, backerId, amount, sharePercentage],
      );
      adPool = insertResult.rows[0];
    }

    // Update the campaign hype score (simple velocity metric: total pool size)
    await this.updateHypeScore(campaignId);

    return adPool;
  }

  /**
   * Update the hype score for a campaign based on conversion velocity
   * and total backing activity.
   */
  async updateHypeScore(campaignId: string): Promise<void> {
    await pool.query(
      `UPDATE campaigns
          SET hype_score = (
            SELECT COALESCE(
              (COUNT(DISTINCT ap.backer_id)::numeric * 0.4) +
              (COALESCE(SUM(ap.total_allocated_budget), 0) / 1000000.0 * 0.3) +
              (COUNT(DISTINCT o.id)::numeric * 0.3),
              0
            )
            FROM campaigns c
            LEFT JOIN ad_pools ap ON ap.campaign_id = c.id
            LEFT JOIN orders o ON o.campaign_id = c.id
                               AND o.escrow_status != 'voided'
            WHERE c.id = $1
          )
        WHERE id = $1`,
      [campaignId],
    );
  }

  /**
   * Get the Arena discovery feed: active campaigns sorted by hype score.
   */
  async getArenaFeed(limit = 20, offset = 0): Promise<ArenaItem[]> {
    const result = await pool.query<ArenaItem>(
      `SELECT
         c.id AS campaign_id,
         p.title AS product_title,
         c.ad_video_url,
         c.landing_page_url,
         c.hype_score,
         COUNT(DISTINCT ap.backer_id)::int AS squad_size,
         p.backer_buyin_threshold AS min_stack_amount
       FROM campaigns c
       JOIN products p ON p.id = c.product_id
       LEFT JOIN ad_pools ap ON ap.campaign_id = c.id
       WHERE c.is_active = TRUE
         AND c.status = 'active'
       GROUP BY c.id, p.title, p.backer_buyin_threshold
       ORDER BY c.hype_score DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return result.rows;
  }

  /**
   * Pause a campaign (used by budget monitor or content control window).
   */
  async pauseCampaign(
    campaignId: string,
    reason: 'paused_out_of_funds' | 'paused_flagged',
  ): Promise<void> {
    await pool.query(
      `UPDATE campaigns
          SET is_active = FALSE,
              status = $1
        WHERE id = $2`,
      [reason, campaignId],
    );
  }

  /**
   * Deduct ad spend from a campaign's backing pool(s).
   * Called as real ad spend is reported by the media buyer AI.
   */
  async deductAdSpend(campaignId: string, spendAmount: number): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Get total remaining budget across all pools
      const totalResult = await client.query<{ total: number }>(
        `SELECT COALESCE(SUM(remaining_budget), 0) AS total
           FROM ad_pools
          WHERE campaign_id = $1`,
        [campaignId],
      );
      const totalRemaining = Number(totalResult.rows[0].total);

      if (totalRemaining < spendAmount) {
        throw new Error(
          `Insufficient ad pool balance for campaign ${campaignId}`,
        );
      }

      // Deduct proportionally from each backer's remaining budget
      await client.query(
        `UPDATE ad_pools
            SET remaining_budget = GREATEST(
              remaining_budget - (remaining_budget / $1 * $2),
              0
            )
          WHERE campaign_id = $3`,
        [totalRemaining, spendAmount, campaignId],
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

export const campaignService = new CampaignService();
