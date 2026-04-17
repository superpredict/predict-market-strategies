import dotenv from 'dotenv';
import { closeRedis } from '../shared/redis.js';
import { getActiveMarket, getMarketInfo, getMarketInfoBySlug } from '../shared/state.js';
import { generateMarketRoundReport } from './marketRoundReport.js';

dotenv.config();

interface CliOptions {
  marketId: string | null;
  slug: string | null;
  useActiveMarket: boolean;
  force: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  let marketId: string | null = null;
  let slug: string | null = null;
  let useActiveMarket = false;
  let force = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--market-id') {
      marketId = argv[++i] ?? null;
    } else if (arg === '--slug') {
      slug = argv[++i] ?? null;
    } else if (arg === '--active-market') {
      useActiveMarket = true;
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
generateMarketRoundReport

  --market-id <conditionId>   Generate a report for a specific market id
  --slug <marketSlug>         Generate a report for a specific market slug
  --active-market             Generate a report for the current active market
  --force                     Overwrite existing markdown/csv files
  --help, -h                  Show this help

Examples:
  npx tsx takerbot/tools/generateMarketRoundReport.ts --active-market
  npx tsx takerbot/tools/generateMarketRoundReport.ts --slug btc-updown-15m-1774851300 --force
  npx tsx takerbot/tools/generateMarketRoundReport.ts --market-id 0x1234abcd
`);
      process.exit(0);
    }
  }

  return { marketId, slug, useActiveMarket, force };
}

async function resolveMarket(options: CliOptions) {
  if (options.marketId) return getMarketInfo(options.marketId);
  if (options.slug) return getMarketInfoBySlug(options.slug);
  if (options.useActiveMarket || (!options.marketId && !options.slug)) return getActiveMarket();
  return null;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const market = await resolveMarket(options);

  if (!market) {
    throw new Error('Market not found in Redis. Try --market-id, --slug, or wait until marketDiscovery stores it.');
  }

  const result = await generateMarketRoundReport(market, { force: options.force });
  const verb = result.skipped ? 'skipped existing report' : 'generated report';

  console.log(
    `[generateMarketRoundReport] ${verb} ` +
      `market=${result.marketId} rows=${result.rowCount} ` +
      `md=${result.markdownPath} csv=${result.csvPath}`,
  );
}

main()
  .catch((error) => {
    console.error('[generateMarketRoundReport] fatal:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeRedis();
  });
