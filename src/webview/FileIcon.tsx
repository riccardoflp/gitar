import { useSyncExternalStore, type CSSProperties } from 'react';
import { fileIcon, folderIcon, type FileIconTheme } from '../shared/fileIcons';
import { Icon } from './Icon';
import { onMessage, post } from './vscode';

/** Undefined until the host answered: nothing takes the room of an icon before it is known whether there are any. */
let theme: FileIconTheme | null | undefined;
let asked = false;
const listeners = new Set<() => void>();
/** The fonts of the theme shown, which go when another comes. */
let fonts: FontFace[] = [];
/** Counts the themes taken, for the names of their fonts: those of the one before may still be loading. */
let taken = 0;
const family = (id: string) => `gitardo-file-icons-${taken}-${id}`;

function take(next: FileIconTheme | null): void {
  for (const font of fonts) document.fonts.delete(font);
  taken++;
  fonts = (next?.fonts ?? []).map((font) => {
    const face = new FontFace(family(font.id), font.src, { weight: font.weight, style: font.style, display: 'block' });
    document.fonts.add(face);
    // A font that does not load leaves its icons blank, as in VS Code.
    face.load().catch(() => undefined);
    return face;
  });
  theme = next;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  if (!asked) {
    asked = true;
    onMessage((message) => message.type === 'fileIcons' && take(message.theme));
    post({ type: 'fileIcons' });
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The file icon theme of VS Code: null when it has none, or until it is known. */
export const useFileIcons = () => useSyncExternalStore(subscribe, () => theme) ?? null;

function Glyph({ theme, id }: { theme: FileIconTheme; id: string | undefined }) {
  const icon = id && Object.hasOwn(theme.icons, id) ? theme.icons[id] : undefined;
  let style: CSSProperties | undefined;
  let character: string | undefined;
  if (icon?.image) {
    const url = `url("${icon.image}")`;
    // A picture that takes the color of the text is a mask over it.
    style = theme.currentColor ? { backgroundColor: 'currentColor', mask: `${url} no-repeat center / 16px`, WebkitMask: `${url} no-repeat center / 16px` } : { backgroundImage: url };
  } else if (icon?.character) {
    const font = (icon.font && theme.fonts.find((candidate) => candidate.id === icon.font)) || theme.fonts[0];
    character = icon.character;
    style = { color: icon.color, fontFamily: font && family(font.id), fontSize: icon.size ?? font?.size ?? theme.fonts[0]?.size };
  }
  // The room of an icon stays, empty, for a file the theme has none for: the names stay in line. The character is drawn
  // by the style, as VS Code draws it, to stay out of the text of the row: what is copied, and what tests read.
  return <span className="file-icon" style={style} data-character={character} aria-hidden="true" />;
}

/** The icon the file icon theme gives a file, or nothing when the user chose no theme. */
export function FileIcon({ path }: { path: string }) {
  const theme = useFileIcons();
  return theme && <Glyph theme={theme} id={fileIcon(theme, path)} />;
}

/**
 * The icon of a file or of a folder, where both are listed with an icon each: that of the file icon theme, or the file
 * or the folder of the codicons when the user chose no theme. A folder in a theme with icons only for files keeps the
 * room of one, empty, for the names to stay in line.
 */
export function EntryIcon({ path, folder }: { path: string; folder: boolean }) {
  const shown = useSyncExternalStore(subscribe, () => theme);
  // Nothing in its place until the host answered, rather than one icon and then another.
  if (shown === undefined) return <span className="file-icon" aria-hidden="true" />;
  if (!shown) return <Icon name={folder ? 'folder' : 'file'} />;
  return <Glyph theme={shown} id={folder ? folderIcon(shown, path, false) : fileIcon(shown, path)} />;
}

/** The icon the file icon theme gives a folder, open or closed: nothing in a theme with icons only for files. */
export function FolderIcon({ path, open }: { path: string; open: boolean }) {
  const theme = useFileIcons();
  const id = theme && folderIcon(theme, path, open);
  return theme && id && <Glyph theme={theme} id={id} />;
}
