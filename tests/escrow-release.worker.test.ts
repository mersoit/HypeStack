import { EscrowReleaseWorker } from '../src/workers/escrow-release.worker';

jest.mock('../src/db/connection', () => ({
  pool: {
    query: jest.fn(),
    connect: jest.fn(),
    on: jest.fn(),
  },
}));

jest.mock('../src/services/order.service', () => ({
  orderService: {
    releaseEscrow: jest.fn(),
  },
}));

import { pool } from '../src/db/connection';
import { orderService } from '../src/services/order.service';

const mockPool = pool as jest.Mocked<typeof pool>;
const mockOrderService = orderService as jest.Mocked<typeof orderService>;

describe('EscrowReleaseWorker', () => {
  let worker: EscrowReleaseWorker;

  beforeEach(() => {
    worker = new EscrowReleaseWorker();
    jest.clearAllMocks();
  });

  test('releases escrow for all eligible orders', async () => {
    (mockPool.query as jest.Mock).mockResolvedValueOnce({
      rows: [{ id: 'order-1' }, { id: 'order-2' }],
    });
    (mockOrderService.releaseEscrow as jest.Mock).mockResolvedValue(undefined);

    const releasedCount = await worker.runCheck();

    expect(releasedCount).toBe(2);
    expect(mockOrderService.releaseEscrow).toHaveBeenCalledTimes(2);
    expect(mockOrderService.releaseEscrow).toHaveBeenCalledWith('order-1');
    expect(mockOrderService.releaseEscrow).toHaveBeenCalledWith('order-2');
  });

  test('does nothing when no orders are eligible', async () => {
    (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

    const releasedCount = await worker.runCheck();

    expect(releasedCount).toBe(0);
    expect(mockOrderService.releaseEscrow).not.toHaveBeenCalled();
  });

  test('query filters for delivered orders in holding status past 7 days', async () => {
    (mockPool.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

    await worker.runCheck();

    const queryCall = (mockPool.query as jest.Mock).mock.calls[0];
    const queryText = queryCall[0] as string;

    expect(queryText).toContain("delivery_status = 'delivered'");
    expect(queryText).toContain("escrow_status = 'holding'");
    expect(queryText).toContain('7 days');
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
