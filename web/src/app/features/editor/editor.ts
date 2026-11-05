import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  ViewEncapsulation,
  afterNextRender,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Editor, Extensions, JSONContent } from '@tiptap/core';
import { Placeholder } from '@tiptap/extensions';
import UniqueID from '@tiptap/extension-unique-id';
import StarterKit from '@tiptap/starter-kit';
import { blockExtensions } from './blocks';
import { BLOCK_ID_TYPES } from './handle/block-commands';
import { BlockFlash, blockFlashKey } from './handle/block-flash';
import { BlockHandle } from './handle/block-handle';
import { BlockKeys } from './handle/block-keys';
import { SlashMenuView } from './slash/slash-menu';
import { SlashMenuController } from './slash/slash-menu.controller';
import { SlashMenu, exitSuggestion, slashMenuKey } from './slash/slash-menu.extension';

/** An empty document: one empty paragraph. */
export const EMPTY_DOC: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] };

/**
 * Blocks: paragraph, H1–H3, bulleted/numbered/to-do lists, quote, divider, toggle, callout and code
 * (T08, T11). Markdown shortcuts (FR-5): "# ", "## ", "### ", "- ", "1. ", "[] ", "> ", "``` ", "---",
 * **bold**, *italic*, `code`. Links come later.
 */
export function editorExtensions(placeholder: string, slash: SlashMenuController | null = null): Extensions {
  return [
    SlashMenu.configure({ controller: slash }),
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      // Replaced by the highlighted code block in ./blocks.
      codeBlock: false,
      link: false,
    }),
    ...blockExtensions(),
    // Stable block ids, so a link can point at a block (block menu > Copy link).
    UniqueID.configure({ types: BLOCK_ID_TYPES, attributeName: 'id' }),
    BlockKeys,
    BlockFlash,
    Placeholder.configure({ placeholder }),
  ];
}

/**
 * Tiptap (ProseMirror) editor wrapped as an Angular component.
 *
 * `content` is read once, when the editor is created; recreate the component to load another
 * document (the page view does this per page, so undo history never crosses pages).
 * Every change is emitted as Tiptap JSON through `contentChange`.
 */
@Component({
  selector: 'app-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // ProseMirror renders its own DOM, so the content styles can't be view-encapsulated.
  encapsulation: ViewEncapsulation.None,
  styleUrl: './editor.scss',
  imports: [SlashMenuView, BlockHandle],
  template: `
    <div class="tp-editor-wrap" #wrap (mousemove)="handle.hover($event)" (mouseleave)="handle.leave()">
      <app-block-handle #handle [editor]="instanceSignal()" [pageId]="pageId()" [container]="wrap" />
      <div class="tp-editor" #host></div>
    </div>
    <app-slash-menu [controller]="slash" />
  `,
})
export class EditorComponent {
  readonly content = input<JSONContent | null>(null);
  readonly label = input('Page content');
  readonly placeholder = input('Start writing…');
  /** False shows the document read-only (e.g. a page in the trash). */
  readonly editable = input(true);
  /** Page id, for links to a block. */
  readonly pageId = input<string | null>(null);
  /** Scroll to and highlight this block once loaded (from a #block-<id> link). */
  readonly focusBlock = input<string | null>(null);
  readonly contentChange = output<JSONContent>();
  /** Emitted once the editor exists (tests and future toolbars use it). */
  readonly ready = output<Editor>();

  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');
  private editor: Editor | null = null;
  /** The editor as a signal, for child views (block handle). */
  protected readonly instanceSignal = signal<Editor | null>(null);
  /** The slash menu ("/"), T10. */
  protected readonly slash = new SlashMenuController(() => {
    if (this.editor) exitSuggestion(this.editor.view, slashMenuKey);
  });

  constructor() {
    afterNextRender(() => {
      this.editor = new Editor({
        element: this.host().nativeElement,
        extensions: editorExtensions(this.placeholder(), this.slash),
        content: this.content() ?? EMPTY_DOC,
        editable: this.editable(),
        editorProps: {
          attributes: {
            role: 'textbox',
            'aria-multiline': 'true',
            'aria-label': this.label(),
            class: 'tp-editor-content',
          },
        },
        // Read-only documents (e.g. a page in the trash) never report changes, so nothing tries to save them.
        // On an editable page, the first ids filled into older content are saved like an edit, so links work.
        onUpdate: ({ editor }) => {
          if (editor.isEditable) this.contentChange.emit(editor.getJSON());
        },
        // Leaving the editor closes the menu (clicks inside the menu don't blur the editor).
        onBlur: () => {
          if (this.slash.open()) this.slash.keyDown(new KeyboardEvent('keydown', { key: 'Escape' }));
        },
      });
      this.instanceSignal.set(this.editor);
      this.ready.emit(this.editor);
    });
    // Point assistive tech from the editor (which keeps focus) to the highlighted menu option.
    effect(() => {
      const open = this.slash.open();
      const hasItems = this.slash.items().length > 0;
      const active = this.slash.activeIndex();
      const dom = this.editor?.view.dom;
      if (!dom) return;
      if (open) {
        dom.setAttribute('aria-controls', this.slash.listId);
        if (hasItems) dom.setAttribute('aria-activedescendant', this.slash.optionId(active));
        else dom.removeAttribute('aria-activedescendant');
      } else {
        dom.removeAttribute('aria-controls');
        dom.removeAttribute('aria-activedescendant');
      }
    });
    // Reveal the block named in the URL (#block-<id>): once the editor exists, and again whenever the link changes.
    effect(() => {
      const editor = this.instanceSignal();
      const id = this.focusBlock();
      if (editor && id) untracked(() => this.revealBlock(id));
    });
    effect(() => {
      const editable = this.editable();
      if (this.editor && this.editor.isEditable !== editable) this.editor.setEditable(editable, false);
    });
    inject(DestroyRef).onDestroy(() => {
      this.editor?.destroy();
      this.editor = null;
    });
  }

  /** Scroll a block into view, put the caret in it and flash it briefly. */
  private revealBlock(id: string | null): void {
    if (!id || !this.editor) return;
    const element = this.editor.view.dom.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`);
    if (!element) return;
    element.scrollIntoView?.({ block: 'center' });
    const editor = this.editor;
    const inside = editor.view.posAtDOM(element, 0);
    const block = editor.state.doc.resolve(inside).before(1);
    editor.view.dispatch(editor.state.tr.setMeta(blockFlashKey, { pos: block }).setMeta('addToHistory', false));
    editor.commands.focus(inside);
    setTimeout(() => {
      if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(blockFlashKey, null));
    }, 2000);
  }

  /** Put the caret at the start or end of the document. */
  focus(position: 'start' | 'end' = 'start'): void {
    this.editor?.commands.focus(position);
  }

  getJSON(): JSONContent | null {
    return this.editor?.getJSON() ?? null;
  }

  /** The Tiptap editor, once created (for toolbars and tests). */
  instance(): Editor | null {
    return this.editor;
  }
}
