import * as fs from 'node:fs';
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
  // The Flow Diff and the Flow Merge: ES modules split in chunks, for the grammars and themes of shiki to load only when a
  // file needs them, and for what the two pages share to be loaded once.
  {
    ...common,
    entryPoints: { main: 'src/flow/webview/main.ts', merge: 'src/flow/webview/merge.ts' },
    outdir: 'dist/flow',
    platform: 'browser',
    format: 'esm',
    splitting: true,
    chunkNames: 'chunks/[name]-[hash]',
    target: 'es2022',
    loader: { '.ttf': 'file' },
  },
  // The colors of the code in the changes of a commit or a comparison: the page imports it only once it shows them, and the grammars
  // of shiki come in chunks of their own as a file needs them.
  {
    ...common,
    entryPoints: { index: 'src/webview/highlight/index.ts' },
    outdir: 'dist/highlight',
    platform: 'browser',
    format: 'esm',
    splitting: true,
    chunkNames: 'chunks/[name]-[hash]',
    target: 'es2022',
  },
  // Monaco's own worker: a webview cannot start one from its files, so the page loads it from a blob.
  {
    ...common,
    entryPoints: ['node_modules/monaco-editor/esm/vs/editor/editor.worker.js'],
    outfile: 'dist/flow/editor.worker.js',
    platform: 'browser',
    format: 'iife',
    minify: true,
    sourcemap: false,
  },
  // Computes the diffs of the Flow Diff away from the thread of the extensions.
  { ...node, entryPoints: ['src/flow/worker.ts'], outfile: 'dist/flowWorker.js' },
  // Serves the webview in a plain browser against a real repository, for working on the UI without an Extension Host.
  { ...node, entryPoints: ['src/dev/server.ts'], outfile: 'dist/dev-server.js' },
  // Runs inside an Extension Host, started by test/e2e/run.mjs.
  { ...node, entryPoints: ['test/e2e/suite.ts'], outfile: 'dist/e2e.js', external: ['vscode'] },
  // Times the reads of a repository: node dist/perf.js <repository>
  { ...node, entryPoints: ['test/perf/measure.ts'], outfile: 'dist/perf.js' },
];

// The chunks are named by their hash: those of an earlier build would stay, and be packaged.
for (const folder of ['dist/flow', 'dist/highlight']) fs.rmSync(folder, { recursive: true, force: true });

if (watch) {
  for (const options of builds) await (await esbuild.context(options)).watch();
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
