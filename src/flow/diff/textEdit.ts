/**
 * Minimal single-range edit between two versions of a text.
 * No `vscode` import — unit-testable with plain node.
 */

/** Replace `[start, end)` of the old text with `text` to get the new one. */
export interface TextReplace {
  start: number;
  end: number;
  text: string;
}

/** 0-based line / UTF-16 column, like vscode.Position. */
export interface LinePosition {
  line: number;
  character: number;
}

/**
 * The smallest single replacement turning `oldText` into `newText` (common
 * prefix and suffix kept), or undefined when they are equal. Never splits a
 * surrogate pair, so the range is always valid for an editor.
 */
export function minimalReplace(oldText: string, newText: string): TextReplace | undefined {
  if (oldText === newText) {
    return undefined;
  }
  const max = Math.min(oldText.length, newText.length);
  let prefix = 0;
  while (prefix < max && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) {
    prefix++;
  }
  if (prefix > 0 && isHighSurrogate(oldText.charCodeAt(prefix - 1))) {
    prefix--;
  }
  let suffix = 0;
  while (
    suffix < max - prefix &&
    oldText.charCodeAt(oldText.length - 1 - suffix) === newText.charCodeAt(newText.length - 1 - suffix)
  ) {
    suffix++;
  }
  if (suffix > 0 && isLowSurrogate(oldText.charCodeAt(oldText.length - suffix))) {
    suffix--;
  }
  return {
    start: prefix,
    end: oldText.length - suffix,
    text: newText.slice(prefix, newText.length - suffix),
  };
}

/** Line/column of an offset in an LF text. */
export function offsetToPosition(text: string, offset: number): LinePosition {
  let line = 0;
  let lineStart = 0;
  for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) {
    line++;
    lineStart = i + 1;
  }
  return { line, character: offset - lineStart };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
