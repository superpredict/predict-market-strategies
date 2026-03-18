import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'takerbot/takerbot.ts',
    'takerbot/feeders/btcPriceFeeder.ts',
    'takerbot/feeders/marketPriceFeeder.ts',
    'takerbot/updater/fairValueUpdater.ts',
    'takerbot/portfolio/portfolioTracker.ts',
  ],
  format: ['esm'],
  dts: false,
  clean: true,
  sourcemap: true,
  minify: false,
  target: 'node20',
  outDir: 'dist',
  splitting: false,
  treeshake: true,
});
