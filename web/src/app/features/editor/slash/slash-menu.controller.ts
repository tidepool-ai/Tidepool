import { computed, signal } from '@angular/core';
import { Range } from '@tiptap/core';
import { SLASH_TABS, SlashCommand, SlashTab, filterCommands } from './slash-commands';

let nextId = 0;

/** Where to draw the menu (viewport coordinates, for position: fixed). */
export interface MenuPosition {
  left: number;
  top: number | null;
  /** Set instead of `top` when the menu opens upward. */
  bottom: number | null;
}

export interface SlashSession {
  query: string;
  range: Range;
  clientRect: (() => DOMRect | null) | null | undefined;
  /** Runs the chosen command (from the suggestion plugin). */
  command: (item: SlashCommand) => void;
}

const MENU_HEIGHT = 360;
const GAP = 4;

/** State and keyboard handling of the slash menu, shared by the editor extension and the menu view. */
export class SlashMenuController {
  readonly listId = `slash-menu-${++nextId}`;
  readonly open = signal(false);
  readonly query = signal('');
  readonly tab = signal<SlashTab>('all');
  readonly activeIndex = signal(0);
  readonly position = signal<MenuPosition>({ left: 0, top: 0, bottom: null });
  readonly items = computed(() => filterCommands(this.query(), this.tab()));
  readonly activeItem = computed(() => this.items()[this.activeIndex()] ?? null);

  private session: SlashSession | null = null;

  constructor(private readonly dismiss: () => void) {}

  optionId(index: number): string {
    return `${this.listId}-option-${index}`;
  }

  start(session: SlashSession): void {
    this.tab.set('all');
    this.update(session);
    this.open.set(true);
  }

  update(session: SlashSession): void {
    if (session.query !== this.query() || !this.session) this.activeIndex.set(0);
    this.session = session;
    this.query.set(session.query);
    this.position.set(this.place(session));
  }

  close(): void {
    this.session = null;
    this.open.set(false);
    this.query.set('');
    this.activeIndex.set(0);
  }

  setTab(tab: SlashTab): void {
    this.tab.set(tab);
    this.activeIndex.set(0);
  }

  /** Returns true when the key was used by the menu (so the editor ignores it). */
  keyDown(event: KeyboardEvent): boolean {
    if (!this.open()) return false;
    const count = this.items().length;
    switch (event.key) {
      case 'ArrowDown':
        if (count) this.activeIndex.set((this.activeIndex() + 1) % count);
        return true;
      case 'ArrowUp':
        if (count) this.activeIndex.set((this.activeIndex() - 1 + count) % count);
        return true;
      case 'Enter':
        if (!count) return false; // nothing to insert: let Enter do its usual job
        this.select(this.activeIndex());
        return true;
      case 'Tab': {
        const tabs = SLASH_TABS.map((t) => t.id);
        const step = event.shiftKey ? -1 : 1;
        this.setTab(tabs[(tabs.indexOf(this.tab()) + step + tabs.length) % tabs.length]);
        return true;
      }
      case 'Escape':
        this.dismiss();
        return true;
      default:
        return false;
    }
  }

  select(index: number): void {
    const item = this.items()[index];
    if (item && this.session) this.session.command(item);
  }

  private place(session: SlashSession): MenuPosition {
    let rect: DOMRect | null;
    try {
      rect = session.clientRect?.() ?? null;
    } catch {
      rect = null; // no layout (e.g. tests)
    }
    if (!rect) return { left: 0, top: 0, bottom: null };
    const viewport = typeof window === 'undefined' ? 1000 : window.innerHeight;
    const fitsBelow = rect.bottom + GAP + MENU_HEIGHT <= viewport || rect.top < MENU_HEIGHT;
    return fitsBelow
      ? { left: rect.left, top: rect.bottom + GAP, bottom: null }
      : { left: rect.left, top: null, bottom: viewport - rect.top + GAP };
  }
}
