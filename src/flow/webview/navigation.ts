import type { AlignedDiffModel } from '../diff/model';

export type Direction = 'next' | 'prev';

export interface NavigationHooks {
  /** Current chunk changed; side effects (decorations, counter, scrolling) live in main.ts. */
  onChange: (current: number, total: number, scroll: boolean) => void;
  /** Shows (or clears, with undefined) the "press again" hint. */
  onHint: (text: string | undefined) => void;
  /** A second press past the first/last chunk: go to the adjacent changed file. */
  onFileJump: (direction: Direction) => void;
}

/**
 * Tracks the current chunk index. With file jumps enabled, stepping past the
 * last (or before the first) chunk first shows a hint and moves on to the
 * adjacent changed file on the second press; otherwise it wraps around.
 */
export class Navigation {
  private current = -1;
  private total = 0;
  private fileJumps = false;
  private armed: Direction | undefined;

  constructor(private readonly hooks: NavigationHooks) {}

  setModel(model: AlignedDiffModel): void {
    this.total = model.chunks.length;
    if (this.total === 0) {
      this.current = -1;
    } else if (this.current >= this.total) {
      this.current = this.total - 1;
    }
    this.hooks.onChange(this.current, this.total, false);
  }

  setFileJumps(enabled: boolean): void {
    this.fileJumps = enabled;
  }

  next(): void {
    this.move('next');
  }

  prev(): void {
    this.move('prev');
  }

  private move(direction: Direction): void {
    if (this.fileJumps && this.atEdge(direction)) {
      if (this.armed === direction) {
        this.disarm();
        this.hooks.onFileJump(direction);
      } else {
        this.armed = direction;
        this.hooks.onHint(
          direction === 'next'
            ? 'Press F7 again to go to the next file'
            : 'Press Shift+F7 again to go to the previous file'
        );
      }
      return;
    }
    this.disarm();
    if (this.total === 0) {
      return;
    }
    const delta = direction === 'next' ? 1 : -1;
    this.current =
      this.current === -1
        ? delta > 0
          ? 0
          : this.total - 1
        : (this.current + delta + this.total) % this.total;
    this.hooks.onChange(this.current, this.total, true);
  }

  private atEdge(direction: Direction): boolean {
    if (this.total === 0) {
      return true;
    }
    return direction === 'next' ? this.current === this.total - 1 : this.current === 0;
  }

  private disarm(): void {
    if (this.armed) {
      this.armed = undefined;
      this.hooks.onHint(undefined);
    }
  }
}
