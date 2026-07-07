import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { ledgerService } from '../services/ledger.service';

const router = Router();

const vaultRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

/**
 * GET /api/vault/:userId
 * Returns the Vault balance summary for a user.
 *
 * Response: { available, pending_escrow, active_ad_float }
 */
router.get('/:userId', vaultRateLimit, async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const balance = await ledgerService.getVaultBalance(userId);
    res.json({ data: balance });
  } catch (err) {
    console.error('[Vault] Balance error:', err);
    res.status(500).json({ error: 'Failed to load Vault balance' });
  }
});

/**
 * GET /api/vault/:userId/transactions
 * Returns the ledger transaction history for a user.
 *
 * Query params:
 *   limit  (number, default 50)
 *   offset (number, default 0)
 */
router.get('/:userId/transactions', vaultRateLimit, async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const limit = parseInt(String(req.query.limit || '50'), 10);
    const offset = parseInt(String(req.query.offset || '0'), 10);

    const { pool } = await import('../db/connection');
    const result = await pool.query(
      `SELECT * FROM ledger_transactions
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3`,
      [userId, limit, offset],
    );

    res.json({ data: result.rows });
  } catch (err) {
    console.error('[Vault] Transactions error:', err);
    res.status(500).json({ error: 'Failed to load transaction history' });
  }
});

export { router as vaultRouter };
