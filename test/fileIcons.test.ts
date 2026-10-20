import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { addressed, readFileIconTheme } from '../src/extension/fileIconTheme';
import { fileIcon, folderIcon, type FileIconTheme } from '../src/shared/fileIcons';

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'gitardo-icons-'));
afterAll(() => fs.rmSync(folder, { recursive: true, force: true }));

/** A theme written as an extension writes it, read as Gitardo reads it, with its files addressed by their names. */
async function theme(document: object, kind: 'dark' | 'light' | 'highContrast' = 'dark', languages?: FileIconTheme['languages']): Promise<FileIconTheme> {
  const file = path.join(folder, 'icons', 'theme.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // As themes are written: with comments and trailing commas.
  fs.writeFileSync(file, `// A theme\n${JSON.stringify(document, null, 2).replace(/\n}$/, ',\n}')}`);
  const read = await readFileIconTheme(file, kind);
  return addressed(read, languages ?? { fileNames: {}, extensions: {} }, (file) => path.relative(folder, file).replaceAll('\\', '/'));
}

const SETI = {
  fonts: [{ id: 'seti', src: [{ path: './seti.woff', format: 'woff' }], weight: 'normal', style: 'normal', size: '150%' }],
  iconDefinitions: {
    _default: { fontCharacter: '\\E023', fontColor: '#d4d7d6' },
    _ts: { fontCharacter: '\\E0A9', fontColor: '#519aba' },
    _ts_light: { fontCharacter: '\\E0A9', fontColor: '#498ba7' },
    _dts: { fontCharacter: '\\E0A9', fontColor: '#cbcb41' },
    _info: { fontCharacter: '\\E05E', fontColor: '#519aba' },
    _json: { fontCharacter: '\\E05C', fontColor: '#cbcb41' },
    _docker: { fontCharacter: '\\E035', fontColor: '#519aba' },
    _src_index: { fontCharacter: '\\E001' },
  },
  file: '_default',
  fileExtensions: { ts: '_ts', 'D.TS': '_dts' },
  fileNames: { 'README.md': '_info', 'src/index.ts': '_src_index' },
  languageIds: { json: '_json', dockerfile: '_docker' },
  light: { fileExtensions: { ts: '_ts_light' } },
};

describe('the icon of a file', () => {
  it('is that of its name first, in any case, then of its longest extension, then of its language, then of every file', async () => {
    const seti = await theme(SETI, 'dark', { fileNames: { dockerfile: 'dockerfile' }, extensions: { '.json': 'json', '.jsonc': 'jsonc' } });
    expect(fileIcon(seti, 'docs/ReadMe.MD')).toBe('_info');
    expect(fileIcon(seti, 'src/types/global.d.ts')).toBe('_dts');
    expect(fileIcon(seti, 'src/App.TS')).toBe('_ts');
    expect(fileIcon(seti, 'build/Dockerfile')).toBe('_docker');
    expect(fileIcon(seti, 'package.json')).toBe('_json');
    // JSON with comments takes the icon of JSON when the theme gives it none, as in VS Code.
    expect(fileIcon(seti, '.vscode/settings.jsonc')).toBe('_json');
    expect(fileIcon(seti, 'LICENSE')).toBe('_default');
  });

  it('can be that of its name in the folder it is in', async () => {
    const seti = await theme(SETI);
    expect(fileIcon(seti, 'packages/app/src/index.ts')).toBe('_src_index');
    expect(fileIcon(seti, 'lib/index.ts')).toBe('_ts');
  });

  it('is never what every object has, for a file named so', async () => {
    const seti = await theme(SETI);
    expect(fileIcon(seti, 'constructor')).toBe('_default');
    expect(fileIcon(seti, 'a.__proto__')).toBe('_default');
  });

  it('is that of the light part of the theme in a light color theme, and the rest of the theme where it says nothing', async () => {
    const light = await theme(SETI, 'light');
    expect(fileIcon(light, 'App.ts')).toBe('_ts_light');
    expect(fileIcon(light, 'README.md')).toBe('_info');
    // A theme with nothing for high contrast keeps its icons there, as in VS Code.
    expect(fileIcon(await theme(SETI, 'highContrast'), 'App.ts')).toBe('_ts');
  });

  it('is undefined when the theme has none for it', async () => {
    const extensionsOnly = await theme({ iconDefinitions: { _ts: { iconPath: './ts.svg' } }, fileExtensions: { ts: '_ts' } });
    expect(fileIcon(extensionsOnly, 'App.ts')).toBe('_ts');
    expect(fileIcon(extensionsOnly, 'LICENSE')).toBeUndefined();
  });
});

describe('the icon of a folder', () => {
  const MINIMAL = {
    iconDefinitions: { _folder: { iconPath: './folder.svg' }, _open: { iconPath: './open.svg' }, _src: { iconPath: './src.svg' }, _srcOpen: { iconPath: './src-open.svg' } },
    folder: '_folder',
    folderExpanded: '_open',
    folderNames: { src: '_src', test: '_src' },
    folderNamesExpanded: { src: '_srcOpen' },
  };

  it('is that of its name, open or closed, else that of every folder', async () => {
    const minimal = await theme(MINIMAL);
    expect(folderIcon(minimal, 'packages/SRC', false)).toBe('_src');
    expect(folderIcon(minimal, 'packages/src', true)).toBe('_srcOpen');
    expect(folderIcon(minimal, 'docs', false)).toBe('_folder');
    expect(folderIcon(minimal, 'docs', true)).toBe('_open');
  });

  it('when open, is that of every open folder before that of the closed one by its name, as in VS Code', async () => {
    expect(folderIcon(await theme(MINIMAL), 'test', true)).toBe('_open');
    expect(folderIcon(await theme({ ...MINIMAL, folderExpanded: undefined }), 'test', true)).toBe('_src');
  });

  it('is undefined in a theme with icons only for files', async () => {
    expect(folderIcon(await theme(SETI), 'src', true)).toBeUndefined();
  });
});

describe('a file icon theme as the page gets it', () => {
  it('has the characters of its fonts as characters, in their colors, and its pictures and fonts at their addresses', async () => {
    const seti = await theme({ ...SETI, iconDefinitions: { ...SETI.iconDefinitions, _bad: { fontCharacter: 'x', fontColor: 'red; background: url(x)' } } });
    expect(seti.icons._ts).toEqual({ character: '', color: '#519aba' });
    // Only colors are let into the page as colors.
    expect(seti.icons._bad).toEqual({ character: 'x' });
    expect(seti.fonts).toEqual([{ id: 'seti', src: 'url("icons/seti.woff") format("woff")', weight: 'normal', style: 'normal', size: '150%' }]);
    const pictures = await theme({ iconDefinitions: { _ts: { iconPath: './images/ts.svg' } }, file: '_ts', hidesExplorerArrows: true });
    expect(pictures.icons._ts).toEqual({ image: 'icons/images/ts.svg' });
    expect(pictures.hidesArrows).toBe(true);
  });

  it('makes its first font as big as VS Code does when the theme does not say', async () => {
    const seti = await theme({ ...SETI, fonts: [{ ...SETI.fonts[0], size: undefined }] });
    expect(seti.fonts[0].size).toBe('150%');
  });
});
