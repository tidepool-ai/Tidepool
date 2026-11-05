import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Editor, JSONContent } from '@tiptap/core';
import { stripIds, type } from '../../../../testing/editor-testing';
import { stubLayoutForProseMirror } from '../../../../testing/prosemirror-jsdom';
import { ImageUploader, UploadError } from '../../../core/files/image-upload';
import { EditorComponent } from '../editor';
import { uploadsOf } from './image-upload';

const p = (text: string): JSONContent => ({ type: 'paragraph', content: [{ type: 'text', text }] });

/** One call to the uploader, settled by the test. */
interface Call {
  file: File;
  progress: (fraction: number) => void;
  resolve: (src: string) => void;
  reject: (error: unknown) => void;
}

@Component({
  imports: [EditorComponent],
  template: `<app-editor
    [content]="initial"
    [editable]="editable()"
    [uploadImage]="uploader()"
    (contentChange)="changes.push($event)"
    (ready)="editor.set($event)"
  />`,
})
class Host {
  initial: JSONContent = { type: 'doc', content: [p('First'), p('Second')] };
  readonly editable = signal(true);
  readonly calls: Call[] = [];
  readonly changes: JSONContent[] = [];
  readonly editor = signal<Editor | null>(null);
  readonly uploader = signal<ImageUploader | null>(
    (file, progress) => new Promise((resolve, reject) => this.calls.push({ file, progress, resolve, reject })),
  );
}

describe('image upload (T13)', () => {
  let fixture: ComponentFixture<Host>;
  let host: Host;
  let editor: Editor;
  let element: HTMLElement;

  const png = (name = 'photo.png') => new File(['png'], name, { type: 'image/png' });
  const blocks = () => (stripIds(editor.getJSON()) as JSONContent).content!;
  const kinds = () => blocks().map((node) => (node.type === 'image' ? `img:${node.attrs!['src']}` : node.content?.[0]?.text ?? '∅'));
  const placeholders = () => Array.from(element.querySelectorAll<HTMLElement>('.tp-upload'));
  const progressbar = () => element.querySelector<HTMLElement>('.tp-upload [role="progressbar"]');
  const button = (label: string) =>
    Array.from(element.querySelectorAll<HTMLButtonElement>('.tp-upload button')).find((b) => b.textContent === label);

  async function stable() {
    fixture.detectChanges();
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve));
  }

  async function render(setup?: (host: Host) => void) {
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    setup?.(host);
    await stable();
    editor = host.editor()!;
    element = fixture.nativeElement;
    host.changes.length = 0; // block ids filled in on load
  }

  /** Put the caret at the end of block `index`. */
  function caretAtEndOf(index: number) {
    let pos = 0;
    for (let i = 0; i <= index; i++) pos += editor.state.doc.child(i).nodeSize;
    editor.commands.setTextSelection(pos - 1);
  }

  function paste(files: File[]) {
    const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, 'clipboardData', {
      value: { files, types: ['Files'], items: [], getData: () => '' },
    });
    editor.view.dom.dispatchEvent(event);
    return event;
  }

  beforeAll(() => stubLayoutForProseMirror());
  afterEach(() => fixture?.destroy());

  describe('while uploading', () => {
    beforeEach(() => render());

    it('a pasted image shows a placeholder with progress after the block, and stays out of the document', async () => {
      caretAtEndOf(0);
      const event = paste([png()]);
      await stable();

      expect(event.defaultPrevented).toBe(true);
      expect(host.calls.map((call) => call.file.name)).toEqual(['photo.png']);
      expect(placeholders()).toHaveLength(1);
      expect(placeholders()[0].textContent).toContain('photo.png');
      expect(progressbar()!.getAttribute('aria-label')).toBe('Uploading photo.png');
      expect(progressbar()!.getAttribute('aria-valuenow')).toBe('0');
      // Between "First" and "Second", where the image will go.
      expect(placeholders()[0].previousElementSibling!.textContent).toBe('First');
      expect(kinds()).toEqual(['First', 'Second']);
      expect(host.changes).toEqual([]); // nothing for autosave yet

      host.calls[0].progress(0.42);
      await stable();
      expect(progressbar()!.getAttribute('aria-valuenow')).toBe('42');
      expect(placeholders()[0].querySelector('.tp-upload-percent')!.textContent).toBe('42%');
      expect(placeholders()[0].querySelector<HTMLElement>('.tp-upload-bar')!.style.width).toBe('42%');
    });

    it('becomes an image block once uploaded, which autosave stores', async () => {
      caretAtEndOf(0);
      paste([png()]);
      await stable();
      host.calls[0].resolve('/api/files/pages/p1/abc.png');
      await stable();

      expect(placeholders()).toHaveLength(0);
      expect(kinds()).toEqual(['First', 'img:/api/files/pages/p1/abc.png', 'Second']);
      expect(blocks()[1].attrs!['alt']).toBe('photo');
      const img = element.querySelector<HTMLImageElement>('img.tp-image')!;
      expect(img.getAttribute('src')).toBe('/api/files/pages/p1/abc.png');
      expect(img.alt).toBe('photo');
      const saved = stripIds(host.changes.at(-1)!);
      expect(saved.content![1]).toMatchObject({ type: 'image', attrs: { src: '/api/files/pages/p1/abc.png' } });
    });

    it('goes before an empty line, so typing carries on below the image', async () => {
      caretAtEndOf(1);
      editor.commands.splitBlock(); // caret on a new empty line after "Second"
      paste([png()]);
      await stable();
      host.calls[0].resolve('/a.png');
      await stable();
      expect(kinds()).toEqual(['First', 'Second', 'img:/a.png', '∅']);
    });

    it('keeps its place while the document changes above it', async () => {
      caretAtEndOf(1);
      paste([png()]);
      await stable();
      editor.commands.insertContentAt(0, p('New top'));
      type(editor, '!');
      host.calls[0].resolve('/a.png');
      await stable();
      expect(kinds()).toEqual(['New top!', 'First', 'Second', 'img:/a.png', '∅']); // the editor keeps a last empty line
    });

    it('uploads several images at once, in order', async () => {
      caretAtEndOf(0);
      paste([png('one.png'), png('two.png')]);
      await stable();
      expect(placeholders().map((el) => el.querySelector('.tp-upload-name')!.textContent)).toEqual(['one.png', 'two.png']);
      host.calls[1].resolve('/two.png');
      await stable();
      host.calls[0].resolve('/one.png');
      await stable();
      expect(kinds()).toEqual(['First', 'img:/one.png', 'img:/two.png', 'Second']);
    });

    it('uploads dropped image files where they were dropped', async () => {
      vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({ pos: 1, inside: 0 });
      const first = editor.view.nodeDOM(0) as HTMLElement;
      vi.spyOn(first, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 600, 20));
      const event = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
      Object.defineProperty(event, 'dataTransfer', { value: { files: [png()], types: ['Files'], getData: () => '' } });
      Object.defineProperty(event, 'clientY', { value: 105 }); // top half of "First"
      editor.view.dom.dispatchEvent(event);
      await stable();
      expect(host.calls).toHaveLength(1);
      host.calls[0].resolve('/drop.png');
      await stable();
      expect(kinds()).toEqual(['img:/drop.png', 'First', 'Second']);
    });

    it('drops below a block when dropped on its lower half', async () => {
      vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({ pos: 1, inside: 0 });
      const first = editor.view.nodeDOM(0) as HTMLElement;
      vi.spyOn(first, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 600, 20));
      const event = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
      Object.defineProperty(event, 'dataTransfer', { value: { files: [png()], types: ['Files'], getData: () => '' } });
      Object.defineProperty(event, 'clientY', { value: 115 });
      editor.view.dom.dispatchEvent(event);
      await stable();
      host.calls[0].resolve('/drop.png');
      await stable();
      expect(kinds()).toEqual(['First', 'img:/drop.png', 'Second']);
    });
  });

  describe('when it fails', () => {
    beforeEach(() => render());

    async function failWith(error: unknown) {
      caretAtEndOf(0);
      paste([png()]);
      await stable();
      host.calls[0].reject(error);
      await stable();
    }

    it('shows why, with Try again and Remove', async () => {
      await failWith(new UploadError('Network error. Check your connection and try again.'));
      const alert = element.querySelector('.tp-upload [role="alert"]')!;
      expect(alert.textContent).toBe("Couldn't upload photo.png. Network error. Check your connection and try again.");
      expect(placeholders()[0].dataset['state']).toBe('error');
      expect(progressbar()).toBeNull();
      expect(button('Try again')!.getAttribute('aria-label')).toBe('Try uploading photo.png again');
      expect(button('Remove')!.getAttribute('aria-label')).toBe('Remove photo.png');
      expect(kinds()).toEqual(['First', 'Second']);
    });

    it('Try again uploads the same file again', async () => {
      await failWith(new UploadError('The upload failed (error 500). Try again.'));
      button('Try again')!.click();
      await stable();
      expect(host.calls).toHaveLength(2);
      expect(host.calls[1].file.name).toBe('photo.png');
      expect(progressbar()!.getAttribute('aria-valuenow')).toBe('0');
      host.calls[1].resolve('/second-try.png');
      await stable();
      expect(kinds()).toEqual(['First', 'img:/second-try.png', 'Second']);
    });

    it('Remove drops the placeholder and leaves the document as it was', async () => {
      await failWith(new UploadError('Boom.'));
      button('Remove')!.click();
      await stable();
      expect(placeholders()).toHaveLength(0);
      expect(uploadsOf(editor)).toEqual([]);
      expect(kinds()).toEqual(['First', 'Second']);
      expect(host.changes).toEqual([]);
    });

    it('offers only Remove when trying again cannot help', async () => {
      await failWith(new UploadError('Images can be up to 25 MB.', false));
      expect(button('Try again')).toBeUndefined();
      expect(button('Remove')).toBeTruthy();
    });

    it('explains unexpected errors in plain words', async () => {
      await failWith(new Error('TypeError: x is undefined'));
      expect(element.querySelector('.tp-upload [role="alert"]')!.textContent).toBe(
        "Couldn't upload photo.png. Couldn't upload the image. Try again.",
      );
    });

    it('an upload removed while still running never lands', async () => {
      caretAtEndOf(0);
      paste([png()]);
      await stable();
      host.calls[0].reject(new UploadError('x'));
      await stable();
      button('Remove')!.click();
      host.calls[0].resolve('/late.png'); // already settled; nothing happens
      await stable();
      expect(kinds()).toEqual(['First', 'Second']);
    });
  });

  describe('the /image command', () => {
    beforeEach(() => render());

    it('opens a file picker for images and uploads what was picked', async () => {
      let picker: HTMLInputElement | null = null;
      const realCreate = document.createElement.bind(document);
      const create = vi.spyOn(document, 'createElement').mockImplementation((tag: string, options?: ElementCreationOptions) => {
        const created = realCreate(tag, options);
        if (created instanceof HTMLInputElement) {
          picker = created;
          vi.spyOn(created, 'click').mockImplementation(() => undefined);
        }
        return created;
      });
      try {
        caretAtEndOf(1);
        editor.commands.splitBlock();
        type(editor, '/image');
        await stable();
        editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        await stable();

        expect(picker).not.toBeNull();
        const input = picker!;
        expect(input.type).toBe('file');
        expect(input.multiple).toBe(true);
        expect(input.accept).toBe('image/png,image/jpeg,image/gif,image/webp,image/avif');
        expect(kinds()).toEqual(['First', 'Second', '∅']); // "/image" removed

        Object.defineProperty(input, 'files', { value: [png('picked.png')] });
        input.dispatchEvent(new Event('change'));
        await stable();
        expect(host.calls.map((call) => call.file.name)).toEqual(['picked.png']);
        host.calls[0].resolve('/picked.png');
        await stable();
        expect(kinds()).toEqual(['First', 'Second', 'img:/picked.png', '∅']);
      } finally {
        create.mockRestore();
      }
    });
  });

  describe('when uploads are off', () => {
    it('leaves pasting to the editor when there is no uploader', async () => {
      await render((h) => h.uploader.set(null));
      caretAtEndOf(0);
      const event = paste([png()]);
      await stable();
      expect(event.defaultPrevented).toBe(false);
      expect(placeholders()).toHaveLength(0);
      expect(editor.commands.pickImage()).toBe(false);
    });

    it('ignores pasted images on a read-only page', async () => {
      await render((h) => h.editable.set(false));
      paste([png()]);
      await stable();
      expect(host.calls).toEqual([]);
      expect(placeholders()).toHaveLength(0);
    });
  });

  describe('image blocks', () => {
    it('load from saved content', async () => {
      await render((h) => {
        h.initial = { type: 'doc', content: [{ type: 'image', attrs: { src: '/api/files/pages/p1/abc.png', alt: 'Chart' } }, p('After')] };
      });
      const img = element.querySelector<HTMLImageElement>('img.tp-image')!;
      expect(img.getAttribute('src')).toBe('/api/files/pages/p1/abc.png');
      expect(img.alt).toBe('Chart');
      expect(editor.getJSON().content![0].attrs!['id']).toBeTruthy(); // the block handle can link to it
    });

    it('pasted HTML keeps linked images but drops data: URLs, rather than storing images in the page', async () => {
      await render();
      editor.commands.insertContent('<img src="https://example.com/a.png" alt="Linked"><img src="data:image/png;base64,AAAA" alt="Inline">');
      const srcs = blocks().filter((node) => node.type === 'image').map((node) => node.attrs!['src']);
      expect(srcs).toEqual(['https://example.com/a.png']);
    });
  });
});
