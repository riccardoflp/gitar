import { describe, expect, it } from 'vitest';
import { choose, cleanPatterns, patternFor, sizeText, statusOf, suggest } from '../src/shared/worktreeSetup';

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
    expect(suggest(folder('secrets')).reason).toBe('Not one Gitardo knows');
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

  it('chooses by the pattern of each one, leaving the others alone', () => {
    const start = { link: ['vendor/'], copy: ['node_modules/', '/.env'] };
    expect(choose(start, folder('node_modules'), 'link')).toEqual({ link: ['vendor/', 'node_modules/'], copy: ['/.env'] });
    expect(choose(start, file('.env'), 'none')).toEqual({ link: ['vendor/'], copy: ['node_modules/'] });
    expect(choose(start, file('.env'), 'copy')).toEqual(start);
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
