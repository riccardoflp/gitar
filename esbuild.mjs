import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
};

const node = { ...common, platform: 'node', format: 'cjs', target: 'node20' };

const builds = [
  { ...node, entryPoints: ['src/extension/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'] },
  {
    ...common,
    entryPoints: ['src/webview/main.tsx'],
    outfile: 'dist/webview.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    jsx: 'automatic',
    loader: { '.ttf': 'file' },
    assetNames: '[name]',
    define: { 'process.env.NODE_ENV': production ? '"production"' : '"development"' },
  },
  // Serves the webview in a plain browser against a real repository, for working on the UI without an Extension Host.
  { ...node, entryPoints: ['src/dev/server.ts'], outfile: 'dist/dev-server.js' },
  // Runs inside an Extension Host, started by test/e2e/run.mjs.
  { ...node, entryPoints: ['test/e2e/suite.ts'], outfile: 'dist/e2e.js', external: ['vscode'] },
  // Times the reads of a repository: node dist/perf.js <repository>
  { ...node, entryPoints: ['test/perf/measure.ts'], outfile: 'dist/perf.js' },
];

if (watch) {
  for (const options of builds) await (await esbuild.context(options)).watch();
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
