import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SyntaxTheme } from './diff/protocol';

/**
 * Resolves the user's active color theme to its raw theme JSON so the webview
 * can feed it to shiki and match the editor's token colors exactly.
 * Returns undefined when the theme cannot be resolved (.tmTheme, missing
 * extension, parse error) — the webview then falls back to Dark+/Light+.
 */
export class ThemeService {
  private readonly cache = new Map<string, SyntaxTheme | undefined>();

  async resolveActive(): Promise<SyntaxTheme | undefined> {
    const name = vscode.workspace.getConfiguration('workbench').get<string>('colorTheme');
    if (!name) {
      return undefined;
    }
    if (!this.cache.has(name)) {
      this.cache.set(name, await this.resolveByName(name).catch(() => undefined));
    }
    return this.cache.get(name);
  }

  private async resolveByName(name: string): Promise<SyntaxTheme | undefined> {
    for (const extension of vscode.extensions.all) {
      const themes = (extension.packageJSON?.contributes?.themes ?? []) as Array<{
        label?: string;
        id?: string;
        path?: string;
        uiTheme?: string;
      }>;
      const entry = themes.find((t) => t.id === name || t.label === name);
      if (!entry?.path) {
        continue;
      }
      const file = path.join(extension.extensionPath, entry.path);
      if (!file.endsWith('.json')) {
        return undefined; // .tmTheme plist themes: let the webview fall back
      }
      const raw = await loadThemeWithIncludes(file);
      const type: SyntaxTheme['type'] = entry.uiTheme === 'vs' ? 'light' : 'dark';
      // Monaco theme names only allow [a-zA-Z0-9-]; slugify once here.
      const slug = name.replace(/[^a-zA-Z0-9-]+/g, '-');
      raw['name'] = slug;
      raw['type'] = type;
      return { name: slug, type, raw };
    }
    return undefined;
  }
}

async function loadThemeWithIncludes(file: string): Promise<Record<string, unknown>> {
  const json = parseJsonc(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
  if (typeof json['include'] === 'string') {
    const parent = await loadThemeWithIncludes(path.join(path.dirname(file), json['include']));
    return mergeThemes(parent, json);
  }
  return normalizeTheme(json);
}

function mergeThemes(
  parent: Record<string, unknown>,
  child: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    ...parent,
    ...child,
    colors: {
      ...((parent['colors'] as object) ?? {}),
      ...((child['colors'] as object) ?? {}),
    },
    tokenColors: [...tokenRules(parent), ...tokenRules(child)],
  };
  delete merged['include'];
  delete merged['settings'];
  return merged;
}

function normalizeTheme(theme: Record<string, unknown>): Record<string, unknown> {
  // Very old themes carry token rules under "settings" instead of "tokenColors".
  if (!Array.isArray(theme['tokenColors']) && Array.isArray(theme['settings'])) {
    theme['tokenColors'] = theme['settings'];
    delete theme['settings'];
  }
  return theme;
}

function tokenRules(theme: Record<string, unknown>): unknown[] {
  const rules = theme['tokenColors'] ?? theme['settings'];
  return Array.isArray(rules) ? rules : [];
}

/** Theme files are JSONC: strip comments and trailing commas, then parse. */
export function parseJsonc(text: string): unknown {
  let out = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        out += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    out += ch;
  }
  out = out.replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(out);
}
