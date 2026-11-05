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
  viewChild,
} from '@angular/core';
import { Editor, Extensions, JSONContent } from '@tiptap/core';
import { Placeholder } from '@tiptap/extensions';
import StarterKit from '@tiptap/starter-kit';
import { blockExtensions } from './blocks';
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
  imports: [SlashMenuView],
  template: '<div class="tp-editor" #host></div><app-slash-menu [controller]="slash" />',
})
export class EditorComponent {
  readonly content = input<JSONContent | null>(null);
  readonly label = input('Page content');
  readonly placeholder = input('Start writing…');
  /** False shows the document read-only (e.g. a page in the trash). */
  readonly editable = input(true);
  readonly contentChange = output<JSONContent>();
  /** Emitted once the editor exists (tests and future toolbars use it). */
  readonly ready = output<Editor>();

  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');
  private editor: Editor | null = null;
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
        onUpdate: ({ editor }) => this.contentChange.emit(editor.getJSON()),
        // Leaving the editor closes the menu (clicks inside the menu don't blur the editor).
        onBlur: () => {
          if (this.slash.open()) this.slash.keyDown(new KeyboardEvent('keydown', { key: 'Escape' }));
        },
      });
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
    effect(() => {
      const editable = this.editable();
      if (this.editor && this.editor.isEditable !== editable) this.editor.setEditable(editable, false);
    });
    inject(DestroyRef).onDestroy(() => {
      this.editor?.destroy();
      this.editor = null;
    });
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
