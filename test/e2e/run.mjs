// Runs the end-to-end suite inside a real VS Code: node test/e2e/run.mjs [--vsix] [path to the VS Code executable]
// VS Code starts as a separate instance with its own throwaway profile, so the one you work in is not touched.
// With --vsix the extension under test is what the packaged .vsix contains, rather than this folder.

import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createWorkspace, environment, findCode, isolated, remove, source } from './fixture.mjs';

const TIMEOUT = 240_000;
const options = process.argv.slice(2).filter((argument) => argument.startsWith('--'));
const [codePath] = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitar-e2e-'));

/** Unpacks the .vsix, which is a zip archive, and returns the folder of the extension inside it. */
function unpackVsix() {
  const { name, version } = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  const vsix = path.join(source, `${name}-${version}.vsix`);
  if (!fs.existsSync(vsix)) throw new Error(`${vsix} not found. Run "npm run package" first.`);
  const dir = path.join(temp, 'vsix');
  fs.mkdirSync(dir);
  // Windows ships a tar that reads zip archives; the one that comes with Git does not, so it is named in full.
  if (process.platform === 'win32') {
    execFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', vsix, '-C', dir]);
  } else {
    execFileSync('unzip', ['-q', vsix, '-d', dir]);
  }
  const unpacked = path.join(dir, 'extension');
  // The suite has to sit inside the extension to be given the same `vscode` API object, whose prompts it replaces.
  fs.copyFileSync(path.join(source, 'dist', 'e2e.js'), path.join(unpacked, 'dist', 'e2e.js'));
  console.log(`Testing the contents of ${path.basename(vsix)}`);
  return unpacked;
}

const extension = options.includes('--vsix') ? unpackVsix() : source;
const { workspace } = createWorkspace(temp);
const results = path.join(temp, 'results.json');

const child = spawn(
  findCode(codePath),
  [
    workspace,
    `--extensionDevelopmentPath=${extension}`,
    `--extensionTestsPath=${path.join(extension, 'dist', 'e2e.js')}`,
    ...isolated(temp),
  ],
  { env: environment({ GITAR_E2E_RESULTS: results }), stdio: 'ignore' },
);

const timer = setTimeout(() => {
  console.error(`Timed out after ${TIMEOUT / 1000}s.`);
  child.kill();
}, TIMEOUT);

child.on('exit', (code) => {
  clearTimeout(timer);
  const steps = fs.existsSync(results) ? JSON.parse(fs.readFileSync(results, 'utf8')) : [];
  for (const step of steps) {
    console.log(`${step.ok ? '  ok  ' : ' FAIL '} ${step.name}`);
    if (!step.ok) console.log(step.error.replace(/^/gm, '        '));
  }
  const failed = steps.filter((step) => !step.ok).length;
  console.log(`\n${steps.length - failed} passed, ${failed} failed (VS Code exited with code ${code})`);
  remove(temp);
  process.exit(steps.length && !failed && code === 0 ? 0 : 1);
});
