import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { FileIconTheme, IconDefinition, IconFont } from '../shared/fileIcons';
import { parseJsonc } from '../shared/jsonc';

// Reads a file icon theme of VS Code with no VS Code in it: the preview server reads one too.

/** The kind of color theme the icons are for: a theme can give other icons in a light one or in high contrast. */
export type ThemeKind = 'dark' | 'light' | 'highContrast';

interface Associations {
  file?: string;
  folder?: string;
  folderExpanded?: string;
  fileNames?: Record<string, string>;
  fileExtensions?: Record<string, string>;
  languageIds?: Record<string, string>;
  folderNames?: Record<string, string>;
  folderNamesExpanded?: Record<string, string>;
}

/** The file of an icon theme, as its extension writes it. */
interface ThemeDocument extends Associations {
  iconDefinitions?: Record<string, { iconPath?: string; fontCharacter?: string; fontColor?: string; fontId?: string; fontSize?: string }>;
  fonts?: { id: string; src: { path: string; format: string }[]; weight?: string; style?: string; size?: string }[];
  light?: Associations;
  highContrast?: Associations;
  hidesExplorerArrows?: boolean;
  usesCurrentColor?: boolean;
}

/** A font of the theme as read, with the paths of its files on disk. */
interface ReadFont extends Omit<IconFont, 'src'> {
  files: { path: string; format: string }[];
}

/** A theme as read, with the paths of its files on disk: `addressed` turns them into what a page can load. */
export interface ReadTheme extends Omit<FileIconTheme, 'languages' | 'fonts'> {
  fonts: ReadFont[];
}

const MAPS = ['fileNames', 'fileExtensions', 'languageIds', 'folderNames', 'folderNamesExpanded'] as const;

/** A map with its names in lower case, as VS Code matches them. */
function lowered(map: Record<string, string> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, icon] of Object.entries(map ?? {})) if (typeof icon === 'string') result[name.toLowerCase()] = icon;
  return result;
}

const COLOR = /^#[0-9a-f]{3,8}$/i;
const SIZE = /^\d+(\.\d+)?(%|px|em|rem)$/;

/** A character as the theme writes it for CSS, such as `\E001`. */
const character = (text: string) =>
  text.replace(/\\([0-9a-f]{1,6})\s?|\\(.)/gi, (_, code: string | undefined, other: string | undefined) => (code ? String.fromCodePoint(parseInt(code, 16)) : other!));

/** Reads the theme in `file` for a color theme of that `kind`: what its light or high contrast part gives takes the place of the rest. */
export async function readFileIconTheme(file: string, kind: ThemeKind): Promise<ReadTheme> {
  const document = parseJsonc(await fs.readFile(file, 'utf8')) as ThemeDocument;
  const folder = path.dirname(file);
  const icons: ReadTheme['icons'] = {};
  for (const [id, definition] of Object.entries(document.iconDefinitions ?? {})) {
    const icon: IconDefinition = {};
    if (definition.iconPath) icon.image = path.join(folder, definition.iconPath);
    else {
      if (definition.fontCharacter) icon.character = character(definition.fontCharacter);
      if (definition.fontColor && COLOR.test(definition.fontColor)) icon.color = definition.fontColor;
      if (definition.fontId) icon.font = definition.fontId;
      if (definition.fontSize && SIZE.test(definition.fontSize)) icon.size = definition.fontSize;
    }
    icons[id] = icon;
  }
  const fonts: ReadFont[] = (document.fonts ?? []).map((font) => ({
    id: font.id,
    files: font.src.map((source) => ({ path: path.join(folder, source.path), format: source.format })),
    weight: font.weight,
    style: font.style,
    size: font.size && SIZE.test(font.size) ? font.size : undefined,
  }));
  // Every character is that big unless its font or itself says otherwise, as in VS Code.
  if (fonts.length) fonts[0].size ??= '150%';
  const variant = kind === 'light' ? document.light : kind === 'highContrast' ? document.highContrast : undefined;
  const theme: ReadTheme = {
    icons,
    fonts,
    file: variant?.file ?? document.file,
    folder: variant?.folder ?? document.folder,
    folderExpanded: variant?.folderExpanded ?? document.folderExpanded,
    fileNames: {},
    fileExtensions: {},
    languageIds: {},
    folderNames: {},
    folderNamesExpanded: {},
    hidesArrows: !!document.hidesExplorerArrows,
    currentColor: !!document.usesCurrentColor,
  };
  for (const map of MAPS) theme[map] = { ...lowered(document[map]), ...lowered(variant?.[map]) };
  // JSON with comments has the icon of JSON when the theme gives it none, as in VS Code.
  if (!theme.languageIds.jsonc && theme.languageIds.json) theme.languageIds.jsonc = theme.languageIds.json;
  return theme;
}

interface LanguageContribution {
  id?: string;
  extensions?: string[];
  filenames?: string[];
}

/**
 * The languages of VS Code by the names and extensions of their files, from the manifests of the extensions that
 * declare them, and from `files.associations` before them: only its patterns that are a name, or any name with an
 * extension, such as `Jenkinsfile` or `*.mdx`.
 */
export function languageMap(manifests: unknown[], associations: Record<string, unknown> = {}): FileIconTheme['languages'] {
  const fileNames: Record<string, string> = {};
  const extensions: Record<string, string> = {};
  for (const manifest of manifests) {
    const languages = (manifest as { contributes?: { languages?: unknown } } | undefined)?.contributes?.languages;
    if (!Array.isArray(languages)) continue;
    for (const language of languages as LanguageContribution[]) {
      if (typeof language?.id !== 'string') continue;
      for (const name of language.filenames ?? []) if (!Object.hasOwn(fileNames, name.toLowerCase())) fileNames[name.toLowerCase()] = language.id;
      for (const ending of language.extensions ?? []) if (!Object.hasOwn(extensions, ending.toLowerCase())) extensions[ending.toLowerCase()] = language.id;
    }
  }
  for (const [pattern, language] of Object.entries(associations)) {
    if (typeof language !== 'string') continue;
    if (/^\*\.[^*?[\]{}/]+$/.test(pattern)) extensions[pattern.slice(1).toLowerCase()] = language;
    else if (!/[*?[\]{}/]/.test(pattern)) fileNames[pattern.toLowerCase()] = language;
  }
  return { fileNames, extensions };
}

/** The theme with its files as the page loads them, each turned into its address by `address`. */
export function addressed(theme: ReadTheme, languages: FileIconTheme['languages'], address: (file: string) => string): FileIconTheme {
  const icons: FileIconTheme['icons'] = {};
  for (const [id, icon] of Object.entries(theme.icons)) icons[id] = icon.image ? { ...icon, image: address(icon.image) } : icon;
  const fonts = theme.fonts.map(({ files, ...font }) => ({
    ...font,
    src: files.map((file) => `url("${address(file.path)}") format("${file.format.replace(/"/g, '')}")`).join(', '),
  }));
  return { ...theme, icons, fonts, languages };
}
