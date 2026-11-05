import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Editor, JSONContent } from '@tiptap/core';
import { press, type } from '../../../../testing/editor-testing';
import { stubLayoutForProseMirror } from '../../../../testing/prosemirror-jsdom';
import { EditorComponent } from '../editor';
import { languageId } from './code-block';

@Component({
  imports: [EditorComponent],
  template: `<app-editor [content]="initial" (ready)="editor.set($event)" />`,
})
class Host {
  initial: JSONContent | null = null;
  readonly editor = signal<Editor | null>(null);
}

const doc = (editor: Editor) => editor.getJSON() as JSONContent;
const first = (editor: Editor) => doc(editor).content![0];

describe('T11 blocks', () => {
  let fixture: ComponentFixture<Host>;
  let editor: Editor;
  let element: HTMLElement;

  async function render(initial: JSONContent | null = null) {
    fixture = TestBed.createComponent(Host);
    fixture.componentInstance.initial = initial;
    fixture.detectChanges();
    await fixture.whenStable();
    editor = fixture.componentInstance.editor()!;
    element = fixture.nativeElement;
    editor.commands.focus('end');
  }

  async function slash(query: string) {
    type(editor, `/${query}`);
    fixture.detectChanges();
    await fixture.whenStable();
    press(editor, 'Enter');
    fixture.detectChanges();
    await fixture.whenStable();
  }

  beforeAll(() => stubLayoutForProseMirror());
  afterEach(() => fixture?.destroy());

  // One test per FR-5 shortcut that T08 didn't already cover (#, ##, ###, -, 1. are in editor.spec).
  describe('Markdown shortcuts (FR-5)', () => {
    it('"[] " starts a to-do list', async () => {
      await render();
      type(editor, '[] Buy milk');
      const list = first(editor);
      expect(list.type).toBe('taskList');
      expect(list.content![0]).toMatchObject({ type: 'taskItem', attrs: { checked: false } });
      expect(editor.getText().trim()).toBe('Buy milk');
    });

    it('"[x] " starts a to-do that is already done', async () => {
      await render();
      type(editor, '[x] Done already');
      expect(first(editor).content![0].attrs).toMatchObject({ checked: true });
    });

    it('"> " starts a quote', async () => {
      await render();
      type(editor, '> To be or not');
      expect(first(editor)).toMatchObject({ type: 'blockquote', content: [{ type: 'paragraph' }] });
      expect(editor.getText().trim()).toBe('To be or not');
    });

    it('"``` " starts a code block', async () => {
      await render();
      type(editor, '``` ');
      expect(first(editor)).toMatchObject({ type: 'codeBlock' });
    });

    it('"```ts " starts a code block in that language', async () => {
      await render();
      type(editor, '```ts ');
      expect(first(editor)).toMatchObject({ type: 'codeBlock', attrs: { language: 'ts' } });
      expect(element.querySelector<HTMLSelectElement>('select[aria-label="Code language"]')!.value).toBe('typescript');
    });

    it('"---" makes a divider', async () => {
      await render();
      type(editor, '---');
      expect(doc(editor).content!.map((node) => node.type)).toContain('horizontalRule');
      expect(editor.getText()).not.toContain('-');
    });

    it('**bold** makes bold text', async () => {
      await render();
      type(editor, 'a **strong** b');
      const [, bold] = first(editor).content!;
      expect(bold).toEqual({ type: 'text', text: 'strong', marks: [{ type: 'bold' }] });
    });

    it('*italic* makes italic text', async () => {
      await render();
      type(editor, 'a *soft* b');
      const [, italic] = first(editor).content!;
      expect(italic).toEqual({ type: 'text', text: 'soft', marks: [{ type: 'italic' }] });
    });

    it('`code` makes inline code', async () => {
      await render();
      type(editor, 'run `npm test` now');
      const [, code] = first(editor).content!;
      expect(code).toEqual({ type: 'text', text: 'npm test', marks: [{ type: 'code' }] });
    });
  });

  describe('to-do list', () => {
    it('has a labelled checkbox that ticks the item', async () => {
      await render();
      type(editor, '[] Buy milk');
      const checkbox = element.querySelector<HTMLInputElement>('ul[data-type="taskList"] input[type="checkbox"]')!;
      expect(checkbox.getAttribute('aria-label')).toBe('To do: Buy milk');

      checkbox.click();
      expect(first(editor).content![0].attrs).toMatchObject({ checked: true });
      expect(checkbox.getAttribute('aria-label')).toBe('Done: Buy milk');
    });

    it('Enter adds another to-do', async () => {
      await render();
      type(editor, '[] One');
      press(editor, 'Enter');
      type(editor, 'Two');
      expect(first(editor).content!.map((item) => item.type)).toEqual(['taskItem', 'taskItem']);
    });
  });

  describe('toggle', () => {
    it('comes from the slash menu with a labelled expand button', async () => {
      await render();
      await slash('toggle');
      expect(first(editor).type).toBe('details');
      const button = element.querySelector<HTMLButtonElement>('[data-type="details"] > button')!;
      expect(button.getAttribute('aria-label')).toBe('Expand toggle');
      expect(button.getAttribute('aria-expanded')).toBe('false');

      button.click();
      expect(button.getAttribute('aria-label')).toBe('Collapse toggle');
      expect(button.getAttribute('aria-expanded')).toBe('true');
      // Open state is saved in the document, so it survives a reload.
      expect(first(editor).attrs).toMatchObject({ open: true });
    });
  });

  describe('callout', () => {
    it('comes from the slash menu as a note with an emoji', async () => {
      await render();
      type(editor, 'Heads up ');
      await slash('callout');
      expect(first(editor)).toMatchObject({ type: 'callout', attrs: { emoji: '💡' } });
      const aside = element.querySelector('aside[data-type="callout"]')!;
      expect(aside.getAttribute('role')).toBe('note');
      expect(aside.querySelector('.tp-callout-emoji')!.getAttribute('aria-hidden')).toBe('true');
      expect(editor.getText().trim()).toBe('Heads up');
    });

    it('Backspace at its start turns it back into a paragraph', async () => {
      await render({
        type: 'doc',
        content: [{ type: 'callout', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Note' }] }] }],
      });
      editor.commands.focus('start');
      press(editor, 'Backspace');
      expect(first(editor)).toEqual({ type: 'paragraph', content: [{ type: 'text', text: 'Note' }] });
    });
  });

  describe('code block', () => {
    it('highlights code for its language', async () => {
      await render({
        type: 'doc',
        content: [{ type: 'codeBlock', attrs: { language: 'javascript' }, content: [{ type: 'text', text: 'const n = 42; // answer' }] }],
      });
      const code = element.querySelector('.tp-code pre code')!;
      expect(code.className).toBe('language-javascript');
      expect(code.querySelector('.hljs-keyword')?.textContent).toBe('const');
      expect(code.querySelector('.hljs-number')?.textContent).toBe('42');
      expect(code.querySelector('.hljs-comment')?.textContent).toBe('// answer');
    });

    it('changes language from the picker, saved in the document', async () => {
      await render({ type: 'doc', content: [{ type: 'codeBlock', content: [{ type: 'text', text: 'SELECT 1' }] }] });
      const select = element.querySelector<HTMLSelectElement>('select[aria-label="Code language"]')!;
      expect(select.value).toBe('plaintext');
      expect(Array.from(select.options).map((o) => o.textContent)).toContain('TypeScript');

      select.value = 'sql';
      select.dispatchEvent(new Event('change'));
      expect(first(editor).attrs).toMatchObject({ language: 'sql' });
      expect(element.querySelector('.tp-code pre code .hljs-keyword')?.textContent).toBe('SELECT');
    });

    it('comes from the slash menu', async () => {
      await render();
      await slash('code');
      expect(first(editor).type).toBe('codeBlock');
    });

    it('Tab indents inside code instead of leaving the block', async () => {
      await render({ type: 'doc', content: [{ type: 'codeBlock', content: [{ type: 'text', text: 'x' }] }] });
      editor.commands.focus('start');
      press(editor, 'Tab');
      expect(first(editor).content![0].text).toBe('  x');
    });

    it('maps language names and aliases to the picker', () => {
      expect(languageId('ts')).toBe('typescript');
      expect(languageId('html')).toBe('xml');
      expect(languageId('PY')).toBe('python');
      expect(languageId('klingon')).toBe('plaintext');
      expect(languageId(null)).toBe('plaintext');
    });
  });

  describe('slash menu', () => {
    it.each([
      ['quote', 'blockquote'],
      ['divider', 'horizontalRule'],
      ['todo', 'taskList'],
    ])('"/%s" inserts a %s', async (query, nodeType) => {
      await render();
      await slash(query);
      expect(doc(editor).content!.map((node) => node.type)).toContain(nodeType);
    });
  });

  it('round-trips every new block through JSON (what autosave stores)', async () => {
    const saved: JSONContent = {
      type: 'doc',
      content: [
        { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Ship' }] }] }] },
        { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Quote' }] }] },
        { type: 'callout', attrs: { emoji: '⚠️' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Careful' }] }] },
        { type: 'horizontalRule' },
        { type: 'codeBlock', attrs: { language: 'python' }, content: [{ type: 'text', text: 'print(1)' }] },
        {
          type: 'details',
          attrs: { open: true },
          content: [
            { type: 'detailsSummary', content: [{ type: 'text', text: 'More' }] },
            { type: 'detailsContent', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hidden' }] }] },
          ],
        },
      ],
    };
    await render(saved);
    expect(doc(editor).content!.slice(0, 6)).toEqual(saved.content);
  });
});
