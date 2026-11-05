import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Editor, JSONContent } from '@tiptap/core';
import { press, type } from '../../../testing/editor-testing';
import { stubLayoutForProseMirror } from '../../../testing/prosemirror-jsdom';
import { EMPTY_DOC, EditorComponent } from './editor';

@Component({
  imports: [EditorComponent],
  template: `<app-editor [content]="initial" (contentChange)="changes.push($event)" (ready)="editor.set($event)" />`,
})
class Host {
  initial: JSONContent | null = null;
  readonly changes: JSONContent[] = [];
  readonly editor = signal<Editor | null>(null);
}

/** The document as plain JSON (Tiptap v3 types getJSON() more narrowly). */
const doc = (editor: Editor): JSONContent => editor.getJSON() as JSONContent;

/**
 * Block types in order, without the empty paragraph Tiptap's TrailingNode keeps after a final
 * heading or list (so there is always somewhere to click below it).
 */
const blocks = (editor: Editor) =>
  (doc(editor).content ?? [])
    .filter((node, i, all) => !(i === all.length - 1 && i > 0 && node.type === 'paragraph' && !node.content)).map((node) => (node.type === 'heading' ? `h${node.attrs?.['level']}` : node.type));

describe('EditorComponent', () => {
  let fixture: ComponentFixture<Host>;
  let host: Host;
  let editor: Editor;

  async function render(initial: JSONContent | null = null) {
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    host.initial = initial;
    fixture.detectChanges();
    await fixture.whenStable();
    editor = host.editor()!;
    editor.commands.focus('end');
  }

  beforeAll(() => stubLayoutForProseMirror());

  afterEach(() => fixture?.destroy());

  it('renders an accessible, empty, editable document with a placeholder', async () => {
    await render();
    const textbox = (fixture.nativeElement as HTMLElement).querySelector('[role="textbox"]')!;
    expect(textbox.getAttribute('contenteditable')).toBe('true');
    expect(textbox.getAttribute('aria-multiline')).toBe('true');
    expect(textbox.getAttribute('aria-label')).toBe('Page content');
    expect(doc(editor)).toEqual(EMPTY_DOC);
    expect(textbox.querySelector('p')?.getAttribute('data-placeholder')).toBe('Start writing…');
  });

  it('loads JSON content into H1–H3, paragraphs and lists', async () => {
    await render({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Plan' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Intro' }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Steps' }] },
        { type: 'orderedList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'One' }] }] }] },
      ],
    });
    const html = (fixture.nativeElement as HTMLElement).querySelector('[role="textbox"]')!.innerHTML;
    expect(html).toContain('<h1>Plan</h1>');
    expect(html).toContain('<h3>Steps</h3>');
    expect(html).toContain('<ol><li><p>One</p></li></ol>');
  });

  it('emits the document as JSON while typing', async () => {
    await render();
    type(editor, 'Hello');

    expect(host.changes.at(-1)).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }],
    });
  });

  it.each([
    ['# ', 'h1'],
    ['## ', 'h2'],
    ['### ', 'h3'],
    ['- ', 'bulletList'],
    ['1. ', 'orderedList'],
  ])('turns "%s" at the start of a line into %s', async (shortcut, block) => {
    await render();
    type(editor, `${shortcut}Title`);
    expect(blocks(editor)).toEqual([block]);
    expect(editor.getText().trim()).toBe('Title'); // getText() separates blocks with newlines
  });

  it('keeps an empty paragraph after a final heading so there is room to keep writing', async () => {
    await render();
    type(editor, '# Title');
    expect(doc(editor).content!.map((node) => node.type)).toEqual(['heading', 'paragraph']);
  });

  it('does not offer H4, and has the FR-3 blocks built so far', async () => {
    await render();
    type(editor, '#### x');
    expect(blocks(editor)).toEqual(['paragraph']);
    for (const name of ['blockquote', 'codeBlock', 'horizontalRule', 'taskList', 'taskItem', 'details', 'callout']) {
      expect(editor.schema.nodes[name], name).toBeDefined();
    }
  });

  describe('lists', () => {
    it('Enter adds an item, and Enter on an empty item leaves the list', async () => {
      await render();
      type(editor, '- First');
      press(editor, 'Enter');
      type(editor, 'Second');
      press(editor, 'Enter');
      press(editor, 'Enter');
      type(editor, 'After');

      const [list, paragraph] = doc(editor).content!;
      expect(blocks(editor)).toEqual(['bulletList', 'paragraph']);
      expect(list.type).toBe('bulletList');
      expect(list.content!.map((item) => item.content![0].content![0].text)).toEqual(['First', 'Second']);
      expect(paragraph).toEqual({ type: 'paragraph', content: [{ type: 'text', text: 'After' }] });
    });

    it('Tab nests an item and Shift+Tab lifts it back', async () => {
      await render();
      type(editor, '1. One');
      press(editor, 'Enter');
      type(editor, 'Two');
      press(editor, 'Tab');
      const nested = doc(editor).content![0].content![0].content!;
      expect(nested.map((node) => node.type)).toEqual(['paragraph', 'orderedList']);

      press(editor, 'Tab', { shift: true });
      expect(doc(editor).content![0].content!).toHaveLength(2);
    });
  });

  describe('undo and redo', () => {
    it('Ctrl+Z undoes typing and Ctrl+Shift+Z redoes it', async () => {
      await render();
      type(editor, 'Draft');
      press(editor, 'z', { ctrl: true });
      expect(editor.getText()).toBe('');
      expect(host.changes.at(-1)).toEqual(EMPTY_DOC);

      press(editor, 'z', { ctrl: true, shift: true });
      expect(editor.getText()).toBe('Draft');
    });

    it('undoes a Markdown shortcut back to the typed characters', async () => {
      await render();
      type(editor, '# ');
      expect(blocks(editor)).toEqual(['h1']);
      press(editor, 'z', { ctrl: true });
      expect(blocks(editor)).toEqual(['paragraph']);
      expect(editor.getText()).toBe('# ');
    });

    it('Ctrl+Y also redoes', async () => {
      await render();
      type(editor, 'x');
      press(editor, 'z', { ctrl: true });
      expect(editor.getText()).toBe('');
      press(editor, 'y', { ctrl: true });
      expect(editor.getText()).toBe('x');
    });
  });

  it('destroys the editor with the component', async () => {
    await render();
    fixture.destroy();
    expect(editor.isDestroyed).toBe(true);
  });
});
