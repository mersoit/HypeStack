import { Router, Request, Response } from 'express';
import { campaignService } from '../services/campaign.service';

const router = Router();

/**
 * GET /api/arena
 * Returns the Arena discovery feed (active campaigns sorted by hype score).
 *
 * Query params:
 *   limit  (number, default 20)
 *   offset (number, default 0)
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(String(req.query.limit || '20'), 10);
    const offset = parseInt(String(req.query.offset || '0'), 10);
    const feed = await campaignService.getArenaFeed(limit, offset);
    res.json({ data: feed });
  } catch (err) {
    console.error('[Arena] Feed error:', err);
    res.status(500).json({ error: 'Failed to load Arena feed' });
  }
});

/**
 * POST /api/arena/stack
 * Backer stacks capital into a campaign (the "Stack In" action).
 *
 * Body: { campaignId, backerId, amount }
 */
router.post('/stack', async (req: Request, res: Response) => {
  try {
    const { campaignId, backerId, amount } = req.body as {
      campaignId: string;
      backerId: string;
      amount: number;
    };

    if (!campaignId || !backerId || !amount) {
      res.status(400).json({ error: 'campaignId, backerId and amount are required' });
      return;
    }

    const adPool = await campaignService.stackIn({
      campaignId,
      backerId,
      amount: Number(amount),
    });

    res.status(201).json({ data: adPool });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to stack in';
    res.status(400).json({ error: message });
  }
});

export { router as arenaRouter };
