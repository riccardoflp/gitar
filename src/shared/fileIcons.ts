/** An icon of the file icon theme: a picture, or a character of one of the theme's fonts. */
export interface IconDefinition {
  /** The address of the picture, as the page can load it. */
  image?: string;
  character?: string;
  color?: string;
  /** The id of the font the character is in: the first of the theme when not given. */
  font?: string;
  /** How big the character is, in CSS: that of the font when not given. */
  size?: string;
}

export interface IconFont {
  id: string;
  /** The `src` of a font face: the addresses of its files, as the page can load them, with their formats. */
  src: string;
  weight?: string;
  style?: string;
  /** How big its characters are, in CSS, such as `150%`. */
  size?: string;
}

/**
 * The file icon theme the user chose in VS Code, as it is for the color theme in use: the icons of its light or high
 * contrast part already take the place of the others. Names and extensions are in lower case.
 */
export interface FileIconTheme {
  icons: Record<string, IconDefinition>;
  fonts: IconFont[];
  /** The icon of a file that nothing else names. */
  file?: string;
  folder?: string;
  folderExpanded?: string;
  fileNames: Record<string, string>;
  /** By extension without its dot, such as `ts` or `d.ts`. */
  fileExtensions: Record<string, string>;
  languageIds: Record<string, string>;
  folderNames: Record<string, string>;
  folderNamesExpanded: Record<string, string>;
  /**
   * The languages of VS Code, by the names and the extensions of their files (with the dot, as `.ts`): for the icons
   * the theme gives a language.
   */
  languages: { fileNames: Record<string, string>; extensions: Record<string, string> };
  /** The theme draws a folder open or closed and wants no arrow beside it. */
  hidesArrows: boolean;
  /** The pictures take the color of the text around them. */
  currentColor: boolean;
}

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1).toLowerCase();

/** The name with that of the folder it is in, such as `src/index.ts`: a theme can name a file or a folder so, for that place only. */
const placedName = (path: string) => {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? undefined : path.slice(path.lastIndexOf('/', slash - 1) + 1).toLowerCase();
};

/** What a map has for a name, never what every object has, such as for a file named `constructor`. */
const own = (map: Record<string, string>, key: string) => (Object.hasOwn(map, key) ? map[key] : undefined);

/** The language VS Code gives a file, from its name or else from the longest extension it knows. */
export function languageOf(languages: FileIconTheme['languages'], name: string): string | undefined {
  const named = own(languages.fileNames, name);
  if (named) return named;
  for (let dot = name.indexOf('.'); dot !== -1; dot = name.indexOf('.', dot + 1)) {
    const language = own(languages.extensions, name.slice(dot));
    if (language) return language;
  }
  return undefined;
}

/**
 * The icon of a file, as VS Code picks it: by its name, else by its extension, the longest first (`d.ts` before `ts`),
 * else by its language, else the icon of every file. Undefined when the theme has none for it.
 */
export function fileIcon(theme: FileIconTheme, path: string): string | undefined {
  const name = baseName(path);
  const placed = placedName(path);
  const named = (placed && own(theme.fileNames, placed)) || own(theme.fileNames, name);
  if (named) return named;
  for (let dot = name.indexOf('.'); dot !== -1; dot = name.indexOf('.', dot + 1)) {
    const icon = own(theme.fileExtensions, name.slice(dot + 1));
    if (icon) return icon;
  }
  const language = languageOf(theme.languages, name);
  return (language && own(theme.languageIds, language)) || theme.file;
}

/** The icon of a folder, open or closed: by its name, else that of every folder. */
export function folderIcon(theme: FileIconTheme, path: string, open: boolean): string | undefined {
  const names = [placedName(path), baseName(path)].filter((name) => name !== undefined);
  const named = (map: Record<string, string>) => names.map((name) => own(map, name)).find(Boolean);
  // In VS Code the icon of every open folder wins over that of a closed one by name.
  if (open) return named(theme.folderNamesExpanded) ?? theme.folderExpanded ?? named(theme.folderNames) ?? theme.folder;
  return named(theme.folderNames) ?? theme.folder;
}
