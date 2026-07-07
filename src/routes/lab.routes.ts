import { Router, Request, Response } from 'express';
import { campaignService } from '../services/campaign.service';

const router = Router();

/**
 * POST /api/lab/campaign
 * Prompter creates a new campaign in the Lab workspace.
 *
 * Body: { productId, creatorId, audienceParams }
 */
router.post('/campaign', async (req: Request, res: Response) => {
  try {
    const { productId, creatorId, audienceParams } = req.body as {
      productId: string;
      creatorId: string;
      audienceParams?: string;
    };

    if (!productId || !creatorId) {
      res.status(400).json({ error: 'productId and creatorId are required' });
      return;
    }

    const campaign = await campaignService.createCampaign({
      productId,
      creatorId,
      audienceParams,
    });

    res.status(201).json({ data: campaign });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create campaign';
    res.status(400).json({ error: message });
  }
});

/**
 * PUT /api/lab/campaign/:id/assets
 * Update a campaign with AI-generated ad assets (video URL, landing page, ad set ID).
 *
 * Body: { adSetId, adVideoUrl, landingPageUrl }
 */
router.put('/campaign/:id/assets', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { adSetId, adVideoUrl, landingPageUrl } = req.body as {
      adSetId: string;
      adVideoUrl: string;
      landingPageUrl: string;
    };

    if (!adSetId || !adVideoUrl || !landingPageUrl) {
      res.status(400).json({ error: 'adSetId, adVideoUrl, and landingPageUrl are required' });
      return;
    }

    const campaign = await campaignService.setAdAssets(id, {
      adSetId,
      adVideoUrl,
      landingPageUrl,
    });

    res.json({ data: campaign });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update ad assets';
    res.status(400).json({ error: message });
  }
});

export { router as labRouter };
