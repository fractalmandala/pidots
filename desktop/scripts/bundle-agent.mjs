// Bundles the computer service that runs inside each Dot's VM.
//   node desktop/scripts/bundle-agent.mjs <outdir>
// Produces <outdir>/agent.mjs and <outdir>/node_modules/playwright-core,
// shared read-only into every VM at /opt/pidots.
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const outdir = process.argv[2];
if (!outdir) throw new Error('Usage: bundle-agent.mjs <outdir>');
rmSync(outdir, { recursive: true, force: true });
mkdirSync(join(outdir, 'node_modules'), { recursive: true });

await build({
  entryPoints: ['src/computer-agent/main.ts'],
  outfile: join(outdir, 'agent.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  minify: true,
  logLevel: 'warning',
  // playwright-core reads its own files at runtime, so it ships beside the bundle.
  external: ['playwright-core'],
});

const require = createRequire(import.meta.url);
const playwright = dirname(require.resolve('playwright-core/package.json'));
cpSync(playwright, join(outdir, 'node_modules', 'playwright-core'), {
  recursive: true,
});
console.log(`Bundled the computer service into ${outdir}`);
