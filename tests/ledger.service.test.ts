import { LedgerService } from '../src/services/ledger.service';

describe('LedgerService.calculateRevenueSplit', () => {
  const service = new LedgerService();

  test('correctly calculates all split fields', () => {
    // Scenario: retail_price = 500,000 VND, floor_cost = 200,000 VND,
    // backer_buyin_threshold = 300,000 VND, ad_cost = 80,000 VND
    const split = service.calculateRevenueSplit(500_000, 200_000, 300_000, 80_000);

    expect(split.gross_revenue).toBe(500_000);
    expect(split.floor_cost).toBe(200_000);
    expect(split.backer_buyin_threshold).toBe(300_000);

    // Upper Delta = 500,000 - 300,000 = 200,000
    expect(split.upper_delta).toBe(200_000);

    // Prompter Delta = 300,000 - 200,000 = 100,000
    expect(split.prompter_delta).toBe(100_000);

    // Platform Split = floor_cost = 200,000
    expect(split.platform_split).toBe(200_000);

    // Prompter Cut = Prompter Delta = 100,000
    expect(split.prompter_cut).toBe(100_000);

    // Backer Split = Upper Delta - ad_cost = 200,000 - 80,000 = 120,000
    expect(split.backer_split).toBe(120_000);

    expect(split.ad_cost_per_purchase).toBe(80_000);
  });

  test('backer split is zero when ad cost equals upper delta', () => {
    const split = service.calculateRevenueSplit(300_000, 100_000, 200_000, 100_000);
    expect(split.upper_delta).toBe(100_000);
    expect(split.backer_split).toBe(0);
  });

  test('backer split is negative when ad cost exceeds upper delta', () => {
    // This represents a loss scenario — the prompter is responsible for oversight
    const split = service.calculateRevenueSplit(300_000, 100_000, 200_000, 150_000);
    expect(split.upper_delta).toBe(100_000);
    expect(split.backer_split).toBe(-50_000);
  });

  test('all values remain consistent at minimum viable pricing', () => {
    // floor == backer_buyin == retail (zero delta scenario)
    const split = service.calculateRevenueSplit(100_000, 100_000, 100_000, 0);
    expect(split.upper_delta).toBe(0);
    expect(split.prompter_delta).toBe(0);
    expect(split.platform_split).toBe(100_000);
    expect(split.prompter_cut).toBe(0);
    expect(split.backer_split).toBe(0);
  });

  test('calculates correctly for large values (high-volume order)', () => {
    // retail=2,000,000 VND, floor=800,000, buyin=1,200,000, adCost=250,000
    const split = service.calculateRevenueSplit(2_000_000, 800_000, 1_200_000, 250_000);

    expect(split.upper_delta).toBe(800_000);       // 2M - 1.2M
    expect(split.prompter_delta).toBe(400_000);    // 1.2M - 0.8M
    expect(split.platform_split).toBe(800_000);    // = floor_cost
    expect(split.prompter_cut).toBe(400_000);      // = prompter_delta
    expect(split.backer_split).toBe(550_000);      // 800k - 250k
  });
});
