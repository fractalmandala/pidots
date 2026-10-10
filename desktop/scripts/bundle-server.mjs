// Bundles the Pidots server into one ESM file for the macOS app, so the app
// ships a few MB of server code instead of the full node_modules tree.
//   node desktop/scripts/bundle-server.mjs <outfile>
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

const outfile = process.argv[2];
if (!outfile) throw new Error('Usage: bundle-server.mjs <outfile>');

// Some packages read their own package.json via createRequire at runtime.
// Inline those reads so the bundle needs no files beside it.
const PACKAGE_JSON_REQUIRE =
  /createRequire\(import\.meta\.url\)\((["'])(\.{1,2}\/(?:[^"']*\/)?package\.json)\1\)/g;
const inlinePackageJson = {
  name: 'inline-package-json',
  setup(build) {
    build.onLoad({ filter: /node_modules[\\/].*\.m?js$/ }, async (args) => {
      const source = await readFile(args.path, 'utf8');
      if (!PACKAGE_JSON_REQUIRE.test(source)) return undefined;
      const imports = [];
      const contents = source.replace(PACKAGE_JSON_REQUIRE, (_, _q, path) => {
        const name = `__inlinedPackageJson${imports.length}`;
        imports.push(`import ${name} from ${JSON.stringify(path)};`);
        return name;
      });
      return { contents: `${imports.join('\n')}\n${contents}`, loader: 'js' };
    });
  },
};

await build({
  entryPoints: ['src/server/index.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  minify: true,
  legalComments: 'external',
  logLevel: 'warning',
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  plugins: [inlinePackageJson],
});
