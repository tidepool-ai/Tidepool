import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  effect,
  inject,
  Injector,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Editor } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import {
  TURN_INTO,
  TopBlock,
  blockHash,
  blockName,
  deleteBlock,
  duplicateBlock,
  ensureBlockId,
  moveBlock,
  selectedBlock,
  topBlockAt,
  turnInto,
} from './block-commands';

interface Target extends TopBlock {
  /** Offset from the top of the editor wrapper, in px. */
  top: number;
  name: string;
}

/**
 * The ⋮⋮ handle beside the hovered block (or the block with the caret): drag it to move the block,
 * click it for the block menu (turn into, duplicate, move, copy link, delete). FR-6, T12.
 */
@Component({
  selector: 'app-block-handle',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './block-handle.html',
  styleUrl: './block-handle.scss',
  host: { '(document:mousedown)': 'closeOnOutsideClick($event)' },
})
export class BlockHandle {
  readonly editor = input<Editor | null>(null);
  /** Page id for "Copy link"; falls back to the current path. */
  readonly pageId = input<string | null>(null);
  /** The element the handle is positioned in (the editor wrapper). */
  readonly container = input.required<HTMLElement>();

  protected readonly turnIntoOptions = TURN_INTO;
  protected readonly target = signal<Target | null>(null);
  protected readonly menuOpen = signal(false);
  protected readonly announcement = signal('');

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly grip = viewChild<ElementRef<HTMLButtonElement>>('grip');
  private readonly menu = viewChild<ElementRef<HTMLElement>>('menu');
  private hovering = false;

  constructor() {
    // Follow the caret while typing or moving with the keyboard, and keep up with edits.
    effect((onCleanup) => {
      const editor = this.editor();
      if (!editor) return;
      const follow = () => {
        if (!this.hovering && !this.menuOpen()) this.showFor(selectedBlock(editor));
        else this.reposition();
      };
      editor.on('selectionUpdate', follow);
      editor.on('update', follow);
      editor.on('focus', follow);
      untracked(follow);
      onCleanup(() => {
        editor.off('selectionUpdate', follow);
        editor.off('update', follow);
        editor.off('focus', follow);
      });
    });
  }

  /** Called by the editor wrapper on mousemove. */
  hover(event: MouseEvent): void {
    const editor = this.editor();
    // While a button is held (pressing the grip to drag), keep the block that was grabbed.
    if (!editor || this.menuOpen() || event.buttons) return;
    if (this.host.nativeElement.contains(event.target as Node)) return; // over the handle itself
    const content = editor.view.dom.getBoundingClientRect();
    // Use the content's left edge, so hovering in the gutter next to a block still finds it.
    const found = editor.view.posAtCoords({ left: content.left + 4, top: event.clientY });
    if (!found) return;
    this.hovering = true;
    this.showFor(topBlockAt(editor, found.inside >= 0 ? found.inside : found.pos));
  }

  /** Called by the editor wrapper on mouseleave. */
  leave(): void {
    this.hovering = false;
  }

  protected toggleMenu(): void {
    if (this.menuOpen()) this.closeMenu(true);
    else this.openMenu();
  }

  openMenu(): void {
    if (!this.target()) return;
    this.menuOpen.set(true);
    afterNextRender(() => this.items()[0]?.focus(), { injector: this.injector });
  }

  protected closeMenu(focusGrip: boolean): void {
    this.menuOpen.set(false);
    if (focusGrip) afterNextRender(() => this.grip()?.nativeElement.focus(), { injector: this.injector });
  }

  protected menuKeydown(event: KeyboardEvent): void {
    const items = this.items();
    const current = items.indexOf(document.activeElement as HTMLElement);
    const focusAt = (index: number) => items[(index + items.length) % items.length]?.focus();
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusAt(current + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusAt(current - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusAt(0);
        break;
      case 'End':
        event.preventDefault();
        focusAt(items.length - 1);
        break;
      case 'Escape':
        event.preventDefault();
        this.closeMenu(true);
        break;
      case 'Tab':
        this.closeMenu(false);
        break;
    }
  }

  protected closeOnOutsideClick(event: MouseEvent): void {
    if (this.menuOpen() && !this.host.nativeElement.contains(event.target as Node)) this.closeMenu(false);
  }

  protected isCurrent(commandId: string): boolean {
    const name = this.target()?.name;
    return TURN_INTO.find((c) => c.id === commandId)?.title === name;
  }

  protected turnInto(commandId: string): void {
    this.act((editor, pos) => turnInto(editor, pos, commandId), 'Block changed');
  }

  protected duplicate(): void {
    this.act((editor, pos) => duplicateBlock(editor, pos), 'Block duplicated');
  }

  protected move(direction: -1 | 1): void {
    this.act((editor, pos) => moveBlock(editor, pos, direction), direction < 0 ? 'Moved up' : 'Moved down');
  }

  protected remove(): void {
    this.act((editor, pos) => deleteBlock(editor, pos), 'Block deleted');
  }

  protected async copyLink(): Promise<void> {
    const editor = this.editor();
    const target = this.target();
    if (!editor || !target) return;
    const id = ensureBlockId(editor, target.pos);
    if (!id) return;
    const path = this.pageId() ? `/p/${this.pageId()}` : location.pathname;
    const url = `${location.origin}${path}#${blockHash(id)}`;
    this.closeMenu(false);
    try {
      await navigator.clipboard.writeText(url);
      this.announcement.set('Link copied');
    } catch {
      this.announcement.set("Couldn't copy the link");
    }
    editor.commands.focus();
  }

  protected canMove(direction: -1 | 1): boolean {
    const editor = this.editor();
    const target = this.target();
    if (!editor || !target) return false;
    const index = target.index + direction;
    return index >= 0 && index < editor.state.doc.childCount;
  }

  /** Drag the whole block: ProseMirror moves the selected node to where it's dropped. */
  protected dragStart(event: DragEvent): void {
    const editor = this.editor();
    const target = this.target();
    if (!editor || !target || !event.dataTransfer) return;
    const { view } = editor;
    const selection = NodeSelection.create(view.state.doc, target.pos);
    view.dispatch(view.state.tr.setSelection(selection));
    const slice = selection.content();
    const { dom, text } = view.serializeForClipboard(slice);
    event.dataTransfer.clearData();
    event.dataTransfer.setData('text/html', dom.innerHTML);
    event.dataTransfer.setData('text/plain', text);
    event.dataTransfer.effectAllowed = 'move';
    const blockDom = view.nodeDOM(target.pos);
    if (blockDom instanceof HTMLElement) event.dataTransfer.setDragImage(blockDom, 0, 0);
    view.dragging = { slice, move: true };
  }

  protected dragEnd(): void {
    const editor = this.editor();
    if (editor) editor.view.dragging = null;
    this.hovering = false;
    this.reposition();
  }

  private act(run: (editor: Editor, pos: number) => boolean, message: string): void {
    const editor = this.editor();
    const target = this.target();
    if (!editor || !target) return;
    this.closeMenu(false);
    if (run(editor, target.pos)) this.announcement.set(message);
    this.hovering = false;
    editor.commands.focus();
    this.showFor(selectedBlock(editor));
  }

  private items(): HTMLElement[] {
    const menu = this.menu()?.nativeElement;
    return menu ? Array.from(menu.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])')) : [];
  }

  private reposition(): void {
    const editor = this.editor();
    const target = this.target();
    if (editor && target) this.showFor(topBlockAt(editor, Math.min(target.pos, editor.state.doc.content.size)));
  }

  private showFor(block: TopBlock | null): void {
    const editor = this.editor();
    if (!editor || !block) {
      this.target.set(null);
      return;
    }
    const dom = editor.view.nodeDOM(block.pos);
    const top =
      dom instanceof HTMLElement
        ? dom.getBoundingClientRect().top - this.container().getBoundingClientRect().top
        : 0;
    this.target.set({ ...block, top, name: blockName(block.node) });
  }
}
