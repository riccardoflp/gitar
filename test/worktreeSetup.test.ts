import { describe, expect, it } from 'vitest';
import { choose, chooseAll, chooseOne, cleanPatterns, groupEntries, patternFor, sizeText, statusNow, statusOf, statusOfAll, suggest } from '../src/shared/worktreeSetup';

const folder = (path: string, bytes = 1000) => ({ path, folder: true, bytes });
const file = (path: string, bytes = 100) => ({ path, folder: false, bytes });

describe('what new worktrees get of what git ignores', () => {
  it('proposes to link dependencies, copy local settings and leave the rest', () => {
    expect(suggest(folder('node_modules')).suggestion).toBe('link');
    expect(suggest(folder('packages/web/node_modules')).suggestion).toBe('link');
    expect(suggest(folder('.venv')).suggestion).toBe('link');
    expect(suggest(folder('.yarn/cache')).suggestion).toBe('link');
    expect(suggest(file('.env')).suggestion).toBe('copy');
    expect(suggest(file('apps/api/.env.development')).suggestion).toBe('copy');
    expect(suggest(file('config.local.json')).suggestion).toBe('copy');
    expect(suggest(file('appsettings.Development.json')).suggestion).toBe('copy');
    expect(suggest(folder('.vscode')).suggestion).toBe('copy');
    // What each worktree makes, or does without.
    expect(suggest(folder('dist')).suggestion).toBe('none');
    expect(suggest(folder('server/__pycache__')).suggestion).toBe('none');
    expect(suggest(folder('.claude/worktrees')).suggestion).toBe('none');
    expect(suggest(file('debug.log')).suggestion).toBe('none');
    expect(suggest(file('.DS_Store')).suggestion).toBe('none');
    // A file named like a folder of dependencies is not one.
    expect(suggest(file('vendor')).suggestion).toBe('none');
    expect(suggest(folder('secrets'))).toEqual({ kind: 'unknown', suggestion: 'none' });
    expect([folder('dist'), file('debug.log'), file('.env'), folder('.vscode'), folder('.claude/worktrees')].map((entry) => suggest(entry).kind)).toEqual([
      'build',
      'noise',
      'local',
      'editor',
      'worktrees',
    ]);
  });

  it('puts what git ignores in sections by kind, with what has the same name in several places together', () => {
    const entry = (path: string, isFolder: boolean) => ({ path, folder: isFolder, link: false, files: 1, bytes: 1, more: false, ...suggest({ path, folder: isFolder, bytes: 1 }) });
    const entries = [
      entry('.env', false),
      entry('apps/web/.env.local', false),
      entry('apps/web/dist', true),
      entry('apps/web/node_modules', true),
      entry('notes.txt', false),
      entry('packages/ui/.env.local', false),
      entry('packages/ui/node_modules', true),
      entry('node_modules', false),
    ];
    const sections = groupEntries(entries).map(({ kind, groups }) => [kind, groups.map((group) => `${group.name}×${group.entries.length}`)]);
    expect(sections).toEqual([
      // A file named node_modules is not a folder of dependencies.
      ['unknown', ['notes.txt×1', 'node_modules×1']],
      ['dependencies', ['node_modules×2']],
      ['local', ['.env×1', '.env.local×2']],
      ['build', ['dist×1']],
    ]);
  });

  it('names dependencies wherever they are, and anything else by its path from the top', () => {
    expect(patternFor(folder('node_modules'))).toBe('node_modules/');
    expect(patternFor(folder('packages/web/node_modules'))).toBe('node_modules/');
    expect(patternFor(folder('server/public'))).toBe('/server/public/');
    expect(patternFor(file('.env'))).toBe('/.env');
    expect(patternFor(file('apps/api/.env'))).toBe('/apps/api/.env');
  });

  it('says what each one gets from what the patterns take, whole or in part', () => {
    const taken = { link: ['node_modules', 'packages/web/node_modules'], copy: ['.env', 'config'] };
    expect(statusOf({ path: 'node_modules' }, taken)).toEqual({ choice: 'link', partly: false });
    expect(statusOf({ path: 'config/one.json' }, taken)).toEqual({ choice: 'copy', partly: false });
    expect(statusOf({ path: 'packages' }, taken)).toEqual({ choice: 'link', partly: true });
    expect(statusOf({ path: 'node_modules_old' }, taken)).toEqual({ choice: 'none', partly: false });
  });

  it('says what each one gets as chosen since git was last asked, by its own pattern, and otherwise as git said', () => {
    const checked = { patterns: { link: ['node_modules/'], copy: ['*.local', '/.env'] }, preview: { link: ['node_modules'], copy: ['a.local', '.env'] } };
    const now = { link: [], copy: ['*.local', '/.vscode/'] };
    // Chosen since: its own pattern.
    expect(statusNow(folder('.vscode'), now, checked)).toEqual({ choice: 'copy', partly: false });
    // Its own pattern taken out since.
    expect(statusNow(folder('node_modules'), now, checked)).toEqual({ choice: 'none', partly: false });
    expect(statusNow(file('.env'), now, checked)).toEqual({ choice: 'none', partly: false });
    // Taken by another pattern, as git said.
    expect(statusNow(file('a.local'), now, checked)).toEqual({ choice: 'copy', partly: false });
    expect(statusNow(file('debug.log'), now, checked)).toEqual({ choice: 'none', partly: false });
    // Before git was asked, only what has its own pattern is known.
    expect(statusNow(folder('.vscode'), now, null)).toEqual({ choice: 'copy', partly: false });
    expect(statusNow(file('a.local'), now, null)).toBeNull();
  });

  it('chooses by the pattern of each one, leaving the others alone', () => {
    const start = { link: ['vendor/'], copy: ['node_modules/', '/.env'] };
    expect(choose(start, folder('node_modules'), 'link')).toEqual({ link: ['vendor/', 'node_modules/'], copy: ['/.env'] });
    expect(choose(start, file('.env'), 'none')).toEqual({ link: ['vendor/'], copy: ['node_modules/'] });
    expect(choose(start, file('.env'), 'copy')).toEqual(start);
    // A pattern of its name, typed by hand, goes too: it would still take it.
    expect(choose({ link: [], copy: ['.env', '*.local'] }, file('.env'), 'none')).toEqual({ link: [], copy: ['*.local'] });
  });

  it('says what something gets by a pattern of its name, wherever it is', () => {
    const now = { link: ['node_modules/'], copy: ['.env.local'] };
    expect(statusNow(folder('apps/web/node_modules'), now, null)).toEqual({ choice: 'link', partly: false });
    expect(statusNow(file('apps/web/.env.local'), now, null)).toEqual({ choice: 'copy', partly: false });
    expect(statusNow(file('apps/web/.env'), now, null)).toBeNull();
  });

  it('chooses for all the places of a name by the pattern of the name, and for one by its path', () => {
    const places = [file('apps/web/.env.local'), file('packages/ui/.env.local'), file('.env.local')];
    const all = chooseAll({ link: [], copy: ['/apps/web/.env.local', '*.local'] }, places, 'copy');
    expect(all).toEqual({ link: [], copy: ['*.local', '.env.local'] });
    expect(statusOfAll(places, all, null)).toEqual({ choice: 'copy', partly: false });
    expect(chooseAll(all, places, 'none')).toEqual({ link: [], copy: ['*.local'] });

    // One of them left out: the others keep what the name gave them, each by its path.
    const one = chooseOne(all, places, places[1], 'none');
    expect(one).toEqual({ link: [], copy: ['*.local', '/apps/web/.env.local', '/.env.local'] });
    expect(statusOfAll(places, one, null)).toBeNull();
    const checked = { patterns: one, preview: { link: [], copy: ['apps/web/.env.local', '.env.local'] } };
    expect(statusOfAll(places, one, checked)).toEqual({ choice: 'mixed', partly: false });
    // Chosen as the name gives it: only the pattern of its path goes.
    expect(chooseOne({ link: [], copy: ['.env.local', '/.env.local'] }, places, places[2], 'copy')).toEqual({ link: [], copy: ['.env.local'] });
    // Without the pattern of the name, only its own changes.
    expect(chooseOne({ link: [], copy: [] }, places, places[0], 'copy')).toEqual({ link: [], copy: ['/apps/web/.env.local'] });
  });

  it('keeps patterns trimmed, once each, without empty ones or line breaks', () => {
    expect(cleanPatterns([' node_modules/ ', '', 'node_modules/', 'a\nb', 3, '/.env'])).toEqual(['node_modules/', '/.env']);
    expect(cleanPatterns('node_modules')).toEqual([]);
  });

  it('says sizes as people read them', () => {
    expect(sizeText(512)).toBe('512 B');
    expect(sizeText(1536)).toBe('1.5 KB');
    expect(sizeText(340 * 1024 * 1024)).toBe('340 MB');
    expect(sizeText(3 * 1024 ** 3)).toBe('3.0 GB');
  });
});
