import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Editor, JSONContent } from '@tiptap/core';
import { press, stripIds, type } from '../../../../testing/editor-testing';
import { stubLayoutForProseMirror } from '../../../../testing/prosemirror-jsdom';
import { EditorComponent } from '../editor';

@Component({
  imports: [EditorComponent],
  template: `<app-editor (ready)="editor.set($event)" />`,
})
class Host {
  readonly editor = signal<Editor | null>(null);
}

const doc = (editor: Editor) => stripIds(editor.getJSON() as JSONContent);
const firstBlock = (editor: Editor) => doc(editor).content![0];

describe('slash menu', () => {
  let fixture: ComponentFixture<Host>;
  let editor: Editor;
  let element: HTMLElement;

  beforeAll(() => stubLayoutForProseMirror());

  beforeEach(async () => {
    fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    await fixture.whenStable();
    editor = fixture.componentInstance.editor()!;
    element = fixture.nativeElement;
    editor.commands.focus('end');
  });

  afterEach(() => fixture.destroy());

  async function render() {
    fixture.detectChanges();
    await fixture.whenStable();
  }

  async function typeAndRender(text: string) {
    type(editor, text);
    await render();
  }

  async function key(name: string, modifiers: { shift?: boolean } = {}) {
    const handled = press(editor, name, modifiers);
    await render();
    return handled;
  }

  const menu = () => element.querySelector('.slash-menu');
  const options = () => Array.from(element.querySelectorAll<HTMLElement>('[role="option"]'));
  const optionTitles = () => options().map((o) => o.querySelector('.title')!.textContent!.trim());
  const active = () => options().find((o) => o.getAttribute('aria-selected') === 'true');
  const textbox = () => element.querySelector<HTMLElement>('[role="textbox"]')!;
  const selectedTab = () => element.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim();

  describe('opening', () => {
    it('opens on "/" with the four tabs and every block, the first one active', async () => {
      await typeAndRender('/');
      expect(menu()).toBeTruthy();
      expect(Array.from(element.querySelectorAll('[role="tab"]')).map((t) => t.textContent!.trim())).toEqual([
        'All',
        'Blocks',
        'AI',
        'Embeds',
      ]);
      expect(selectedTab()).toBe('All');
      expect(optionTitles().slice(0, 6)).toEqual(['Text', 'Heading 1', 'Heading 2', 'Heading 3', 'Bulleted list', 'Numbered list']);
      expect(optionTitles()).toHaveLength(13);
      expect(active()?.textContent).toContain('Text');
    });

    it('opens after a space too, but not inside a word (like a URL or a date)', async () => {
      await typeAndRender('Hello /');
      expect(menu()).toBeTruthy();
      await key('Escape');

      await typeAndRender(' and/or');
      expect(menu()).toBeNull();
    });

    it('stays closed until "/" is typed', async () => {
      await typeAndRender('Plain text');
      expect(menu()).toBeNull();
    });
  });

  describe('filtering as you type', () => {
    it('narrows the list and resets the highlight to the best match', async () => {
      await typeAndRender('/');
      await key('ArrowDown');
      await typeAndRender('h2');
      expect(optionTitles()).toEqual(['Heading 2']);
      expect(active()?.textContent).toContain('Heading 2');
    });

    it('shows "No results" when nothing matches, and Enter then just makes a new line', async () => {
      await typeAndRender('/zzz');
      expect(options()).toHaveLength(0);
      expect(element.querySelector('.slash-menu .empty')!.textContent).toContain('No results');
      await key('Enter'); // the menu lets it through, so the editor's own Enter runs
      expect(doc(editor).content).toHaveLength(2);
      expect(menu()).toBeNull();
    });

    it('closes when a space is typed after the query', async () => {
      await typeAndRender('/head');
      expect(menu()).toBeTruthy();
      await typeAndRender(' ');
      expect(menu()).toBeNull();
    });
  });

  describe('keyboard selection', () => {
    it('moves with Up/Down and wraps around', async () => {
      await typeAndRender('/');
      await key('ArrowDown');
      expect(active()?.textContent).toContain('Heading 1');
      await key('ArrowUp');
      await key('ArrowUp');
      expect(active()?.textContent).toContain('Image');
      await key('ArrowDown');
      expect(active()?.textContent).toContain('Text');
    });

    it('Enter inserts the highlighted block and removes the "/query" text', async () => {
      await typeAndRender('/head');
      await key('ArrowDown'); // Heading 2
      expect(await key('Enter')).toBe(true);

      expect(menu()).toBeNull();
      expect(firstBlock(editor)).toEqual({ type: 'heading', attrs: { level: 2 } });
      await typeAndRender('Plan');
      expect(editor.getText().trim()).toBe('Plan');
    });

    it.each([
      ['text', 'paragraph'],
      ['h1', 'heading'],
      ['h3', 'heading'],
      ['bullet', 'bulletList'],
      ['numbered', 'orderedList'],
    ])('"/%s" + Enter inserts a %s', async (query, nodeType) => {
      await typeAndRender(`/${query}`);
      await key('Enter');
      expect(firstBlock(editor).type).toBe(nodeType);
      expect(editor.getText()).not.toContain('/');
    });

    it('turns the current line into the block, keeping text typed before the "/"', async () => {
      await typeAndRender('Groceries /bul');
      await key('Enter');
      const list = firstBlock(editor);
      expect(list.type).toBe('bulletList');
      expect(editor.getText().trim()).toBe('Groceries');
    });

    it('Escape closes the menu and leaves the typed text', async () => {
      await typeAndRender('/head');
      expect(await key('Escape')).toBe(true);
      expect(menu()).toBeNull();
      expect(editor.getText()).toBe('/head');
    });

    it('keeps Up/Down/Enter for the menu instead of moving the caret or splitting the line', async () => {
      await typeAndRender('/');
      expect(await key('ArrowDown')).toBe(true);
      expect(await key('ArrowUp')).toBe(true);
      expect(doc(editor).content).toHaveLength(1);
    });

    it('inside a list item, Enter and Tab still go to the menu (not split or nest the item)', async () => {
      await typeAndRender('- First');
      press(editor, 'Enter');
      await typeAndRender('/bul');
      await key('Tab');
      expect(selectedTab()).toBe('Blocks');
      await key('Enter'); // Bulleted list: already one, so the item just stays
      const list = firstBlock(editor);
      expect(list.type).toBe('bulletList');
      expect(list.content).toHaveLength(2); // no extra item from Enter, no nesting from Tab
      expect(list.content![1]).toEqual({ type: 'listItem', content: [{ type: 'paragraph' }] });
    });

    it('"/text" in a list item turns it into a plain paragraph, like "turn into Text"', async () => {
      await typeAndRender('- First');
      press(editor, 'Enter');
      await typeAndRender('Second /text');
      await key('Enter');
      const [list, paragraph] = doc(editor).content!;
      expect(list.content).toHaveLength(1);
      expect(paragraph).toEqual({ type: 'paragraph', content: [{ type: 'text', text: 'Second ' }] });
    });

    it('scrolls the highlighted option into view', async () => {
      const scrolled: string[] = [];
      const original = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (this: Element) {
        scrolled.push(this.id);
      };
      try {
        await typeAndRender('/');
        await key('ArrowUp'); // wraps to the last option
        expect(scrolled.at(-1)).toBe(active()!.id);
        expect(active()!.textContent).toContain('Image');
      } finally {
        Element.prototype.scrollIntoView = original;
      }
    });

    it('Tab and Shift+Tab switch tabs instead of indenting', async () => {
      await typeAndRender('/');
      await key('Tab');
      expect(selectedTab()).toBe('Blocks');
      await key('Tab');
      expect(selectedTab()).toBe('AI');
      expect(element.querySelector('.slash-menu .empty')!.textContent).toContain('Nothing here yet');
      await key('Tab', { shift: true });
      await key('Tab', { shift: true });
      expect(selectedTab()).toBe('All');
    });
  });

  describe('mouse', () => {
    it('clicking an option inserts it, and pressing in the menu keeps the editor focused', async () => {
      await typeAndRender('/');
      const option = options()[4]; // Bulleted list
      const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      option.dispatchEvent(press);
      expect(press.defaultPrevented).toBe(true);
      option.click();
      await render();
      expect(firstBlock(editor).type).toBe('bulletList');
    });

    it('clicking a tab switches to it', async () => {
      await typeAndRender('/');
      element.querySelectorAll<HTMLButtonElement>('[role="tab"]')[3].click();
      await render();
      expect(selectedTab()).toBe('Embeds');
    });
  });

  describe('accessibility', () => {
    it('exposes a listbox the editor points into with aria-activedescendant', async () => {
      await typeAndRender('/');
      const list = element.querySelector('[role="listbox"]')!;
      expect(list.getAttribute('aria-label')).toBe('Insert block');
      expect(textbox().getAttribute('aria-controls')).toBe(list.id);
      expect(textbox().getAttribute('aria-activedescendant')).toBe(active()!.id);

      await key('ArrowDown');
      expect(textbox().getAttribute('aria-activedescendant')).toBe(active()!.id);

      await key('Escape');
      expect(textbox().hasAttribute('aria-controls')).toBe(false);
      expect(textbox().hasAttribute('aria-activedescendant')).toBe(false);
    });

    it('closes when the editor loses focus', async () => {
      await typeAndRender('/');
      editor.view.dom.dispatchEvent(new FocusEvent('blur'));
      editor.commands.blur();
      await render();
      expect(menu()).toBeNull();
    });
  });
});
