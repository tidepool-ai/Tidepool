import { signal } from '@angular/core';

export type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

/**
 * Debounced autosave for one document. `change()` on every edit; the latest value is saved once
 * edits pause for `delayMs`. At most one save runs at a time: edits made during a save are saved
 * right after it. A failed save keeps the value as unsaved until the next edit or `flush()`.
 */
export class Autosave<T> {
  readonly status = signal<SaveStatus>('idle');
  /** The error from the last failed save, cleared by the next successful one. */
  readonly error = signal<unknown>(null);

  private latest: T | undefined;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly save: (value: T) => Promise<unknown>,
    private readonly delayMs = 1000,
  ) {}

  /** True while there are edits the server doesn't have yet. */
  get hasUnsavedChanges(): boolean {
    return this.dirty || this.inFlight !== null;
  }

  change(value: T): void {
    this.latest = value;
    this.dirty = true;
    this.status.set('pending');
    this.clearTimer();
    this.timer = setTimeout(() => void this.flush(), this.delayMs);
  }

  /** Save now if anything is unsaved (used on retry, page change and leaving). */
  async flush(): Promise<void> {
    this.clearTimer();
    if (this.inFlight) {
      await this.inFlight;
      if (!this.dirty) return;
      return this.flush();
    }
    if (!this.dirty) return;
    this.dirty = false;
    const value = this.latest as T;
    this.status.set('saving');
    this.inFlight = this.save(value)
      .then(() => {
        this.error.set(null);
        this.status.set(this.dirty ? 'pending' : 'saved');
      })
      .catch((error: unknown) => {
        this.dirty = true;
        this.error.set(error);
        this.status.set('error');
      })
      .finally(() => (this.inFlight = null));
    await this.inFlight;
    // Edits that arrived during the save, with no timer left to pick them up.
    if (this.dirty && this.status() === 'pending' && !this.timer) await this.flush();
  }

  dispose(): void {
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
