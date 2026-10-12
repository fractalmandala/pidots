// Bundles the computer service and router that run inside the shared VM.
//   node desktop/scripts/bundle-agent.mjs <outdir>
// Produces <outdir>/agent.mjs, <outdir>/router.mjs and <outdir>/node_modules/playwright-core,
// shared read-only into the VM at /opt/pidots.
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const outdir = process.argv[2];
if (!outdir) throw new Error('Usage: bundle-agent.mjs <outdir>');
rmSync(outdir, { recursive: true, force: true });
mkdirSync(join(outdir, 'node_modules'), { recursive: true });

await build({
  // agent.mjs: one per Dot, as that Dot's user. router.mjs: one per VM, as root.
  entryPoints: {
    agent: 'src/computer-agent/main.ts',
    router: 'src/computer-agent/router.ts',
  },
  outdir,
  outExtension: { '.js': '.mjs' },
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
