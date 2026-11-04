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

/** An empty document: one empty paragraph. */
export const EMPTY_DOC: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] };

/**
 * T08 blocks: paragraphs, H1–H3, bulleted and numbered lists, inline marks, undo/redo.
 * Markdown shortcuts come with StarterKit ("# ", "## ", "### ", "- ", "1. ").
 * Quote, code block and divider arrive with T11; links later.
 */
export function editorExtensions(placeholder: string): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      blockquote: false,
      codeBlock: false,
      horizontalRule: false,
      link: false,
    }),
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
  template: '<div class="tp-editor" #host></div>',
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

  constructor() {
    afterNextRender(() => {
      this.editor = new Editor({
        element: this.host().nativeElement,
        extensions: editorExtensions(this.placeholder()),
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
      });
      this.ready.emit(this.editor);
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
