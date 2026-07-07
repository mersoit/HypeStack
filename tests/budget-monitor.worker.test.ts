import { BudgetMonitorWorker } from '../src/workers/budget-monitor.worker';

// Mock the database pool to avoid needing a live DB in unit tests
jest.mock('../src/db/connection', () => ({
  pool: {
    query: jest.fn(),
    connect: jest.fn(),
    on: jest.fn(),
  },
}));

jest.mock('../src/services/campaign.service', () => ({
  campaignService: {
    pauseCampaign: jest.fn(),
  },
}));

import { pool } from '../src/db/connection';
import { campaignService } from '../src/services/campaign.service';

const mockPool = pool as jest.Mocked<typeof pool>;
const mockCampaignService = campaignService as jest.Mocked<typeof campaignService>;

describe('BudgetMonitorWorker', () => {
  let worker: BudgetMonitorWorker;

  beforeEach(() => {
    worker = new BudgetMonitorWorker();
    jest.clearAllMocks();
  });

  test('pauses campaigns with remaining budget below 50,000 VND', async () => {
    (mockPool.query as jest.Mock).mockResolvedValueOnce({
      rows: [
        { campaign_id: 'campaign-1', total_remaining: 30_000 },
        { campaign_id: 'campaign-2', total_remaining: 10_000 },
      ],
    });

    (mockCampaignService.pauseCampaign as jest.Mock).mockResolvedValue(undefined);

    const pausedCount = await worker.runCheck();

    expect(pausedCount).toBe(2);
    expect(mockCampaignService.pauseCampaign).toHaveBeenCalledTimes(2);
    expect(mockCampaignService.pauseCampaign).toHaveBeenCalledWith(
      'campaign-1',
      'paused_out_of_funds',
    );
    expect(mockCampaignService.pauseCampaign).toHaveBeenCalledWith(
      'campaign-2',
      'paused_out_of_funds',
    );
  });

  test('does not pause campaigns with sufficient budget', async () => {
    (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

    const pausedCount = await worker.runCheck();

    expect(pausedCount).toBe(0);
    expect(mockCampaignService.pauseCampaign).not.toHaveBeenCalled();
  });

  test('queries with the 50,000 VND safety threshold', async () => {
    (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

    await worker.runCheck();

    const queryCall = (mockPool.query as jest.Mock).mock.calls[0];
    const queryParams = queryCall[1];
    // The threshold is the first parameter
    expect(queryParams[0]).toBe(50_000);
  });

  test('start and stop manage the interval correctly', () => {
    jest.useFakeTimers();

    worker.start();
    expect(worker['intervalHandle']).not.toBeNull();

    worker.stop();
    expect(worker['intervalHandle']).toBeNull();

    jest.useRealTimers();
  });
});
