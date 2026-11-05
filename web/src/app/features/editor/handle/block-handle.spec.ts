import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Editor, JSONContent } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import { press, stripIds } from '../../../../testing/editor-testing';
import { stubLayoutForProseMirror } from '../../../../testing/prosemirror-jsdom';
import { EditorComponent } from '../editor';
import { blockName, deleteBlock, duplicateBlock, moveBlock, topBlockAt, turnInto } from './block-commands';

const p = (text: string): JSONContent => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const START: JSONContent = {
  type: 'doc',
  content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Plan' }] }, p('One'), p('Two'), p('Three')],
};

@Component({
  imports: [EditorComponent],
  template: `<app-editor [content]="initial" [pageId]="'page-1'" [focusBlock]="focusBlock()" (contentChange)="changes.push($event)" (ready)="editor.set($event)" />`,
})
class Host {
  initial: JSONContent = START;
  readonly focusBlock = signal<string | null>(null);
  readonly changes: JSONContent[] = [];
  readonly editor = signal<Editor | null>(null);
}

describe('block handle (T12)', () => {
  let fixture: ComponentFixture<Host>;
  let editor: Editor;
  let element: HTMLElement;

  const texts = () => (stripIds(editor.getJSON()) as JSONContent).content!.map((node) => node.content?.[0]?.text ?? node.type);
  const posOf = (index: number) => {
    let pos = 0;
    for (let i = 0; i < index; i++) pos += editor.state.doc.child(i).nodeSize;
    return pos;
  };

  async function render(initial: JSONContent = START, focusBlock: string | null = null) {
    fixture = TestBed.createComponent(Host);
    fixture.componentInstance.initial = initial;
    fixture.componentInstance.focusBlock.set(focusBlock);
    fixture.detectChanges();
    await fixture.whenStable();
    editor = fixture.componentInstance.editor()!;
    element = fixture.nativeElement;
    await new Promise((resolve) => setTimeout(resolve)); // UniqueID fills in ids just after creation
  }

  async function stable() {
    fixture.detectChanges();
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve));
  }

  /** Put the caret in block `index` so the handle follows it. */
  async function caretIn(index: number) {
    editor.commands.focus(posOf(index) + 1);
    // Tiptap moves DOM focus on the next animation frame; let that happen before anything else.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await stable();
  }

  const grip = () => element.querySelector<HTMLButtonElement>('.grip')!;
  const menuItem = (text: string) =>
    Array.from(element.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')).find((b) => b.textContent!.includes(text))!;

  async function openMenu(index: number) {
    await caretIn(index);
    grip().click();
    await stable();
  }

  beforeAll(() => stubLayoutForProseMirror());
  afterEach(() => fixture?.destroy());

  describe('block commands', () => {
    beforeEach(() => render());

    it('finds the top-level block at a position and names it', () => {
      const block = topBlockAt(editor, posOf(2) + 2)!;
      expect(block.index).toBe(2);
      expect(blockName(block.node)).toBe('Text');
      expect(blockName(topBlockAt(editor, 1)!.node)).toBe('Heading 2');
    });

    it('moves a block up and down, not past the edges', () => {
      expect(moveBlock(editor, posOf(2), -1)).toBe(true);
      expect(texts()).toEqual(['Plan', 'Two', 'One', 'Three']);
      expect(moveBlock(editor, posOf(1), 1)).toBe(true);
      expect(texts()).toEqual(['Plan', 'One', 'Two', 'Three']);
      expect(moveBlock(editor, posOf(0), -1)).toBe(false);
      expect(moveBlock(editor, posOf(3), 1)).toBe(false);
    });

    it('gives every block an id once loaded', () => {
      const ids = (editor.getJSON() as JSONContent).content!.map((node) => node.attrs?.['id']);
      expect(ids.every(Boolean)).toBe(true);
    });

    it('duplicates a block right after it, with its own id', () => {
      duplicateBlock(editor, posOf(1));
      expect(texts()).toEqual(['Plan', 'One', 'One', 'Two', 'Three']);
      const ids = (editor.getJSON() as JSONContent).content!.map((node) => node.attrs?.['id']);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('deletes a block, and leaves one empty paragraph when it was the last', async () => {
      deleteBlock(editor, posOf(1));
      expect(texts()).toEqual(['Plan', 'Two', 'Three']);
      fixture.destroy();
      await render({ type: 'doc', content: [p('Only')] });
      deleteBlock(editor, 0);
      expect(stripIds(editor.getJSON())).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
    });

    it('turns a block into another kind, keeping its text', () => {
      turnInto(editor, posOf(1), 'h1');
      expect(stripIds((editor.getJSON() as JSONContent).content![1])).toEqual({
        type: 'heading',
        attrs: { level: 1 },
        content: [{ type: 'text', text: 'One' }],
      });
      turnInto(editor, posOf(2), 'todo');
      expect((editor.getJSON() as JSONContent).content![2].type).toBe('taskList');
    });

    it('Alt+Shift+↑/↓ move the block with the caret', async () => {
      await caretIn(3);
      press(editor, 'ArrowUp', { shift: true, alt: true });
      expect(texts()).toEqual(['Plan', 'One', 'Three', 'Two']);
      press(editor, 'ArrowDown', { shift: true, alt: true });
      expect(texts()).toEqual(['Plan', 'One', 'Two', 'Three']);
    });
  });

  describe('handle', () => {
    beforeEach(() => render());

    it('follows the block with the caret and names it', async () => {
      await caretIn(0);
      expect(grip().getAttribute('aria-label')).toBe('Block menu: Heading 2');
      await caretIn(2);
      expect(grip().getAttribute('aria-label')).toBe('Block menu: Text');
      expect(grip().getAttribute('aria-haspopup')).toBe('menu');
      expect(grip().getAttribute('aria-expanded')).toBe('false');
    });

    it('follows the hovered block, but not while a button is held (dragging the grabbed one)', async () => {
      await caretIn(2);
      vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({ pos: posOf(0) + 1, inside: -1 });
      const wrap = element.querySelector('.tp-editor-wrap')!;
      wrap.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 1 }));
      await stable();
      expect(grip().getAttribute('aria-label')).toBe('Block menu: Text');
      wrap.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      await stable();
      expect(grip().getAttribute('aria-label')).toBe('Block menu: Heading 2');
    });

    it('starts a drag of the whole block, which ProseMirror moves on drop', async () => {
      await caretIn(2);
      const data = new Map<string, string>();
      const event = new Event('dragstart', { bubbles: true }) as DragEvent;
      Object.defineProperty(event, 'dataTransfer', {
        value: {
          clearData: () => data.clear(),
          setData: (type: string, value: string) => data.set(type, value),
          setDragImage: vi.fn(),
          effectAllowed: 'none',
        },
      });
      grip().dispatchEvent(event);

      expect(editor.view.dragging?.move).toBe(true);
      expect(editor.view.dragging?.slice.content.firstChild?.textContent).toBe('Two');
      expect(editor.state.selection).toBeInstanceOf(NodeSelection);
      expect(data.get('text/plain')).toBe('Two');

      grip().dispatchEvent(new Event('dragend', { bubbles: true }));
      expect(editor.view.dragging).toBeNull();
    });
  });

  describe('block menu', () => {
    beforeEach(() => render());

    it('opens from the handle as a labelled menu, focusing the first item', async () => {
      await openMenu(1);
      const menu = element.querySelector('[role="menu"]')!;
      expect(menu.getAttribute('aria-label')).toBe('Block actions');
      expect(grip().getAttribute('aria-expanded')).toBe('true');
      expect(document.activeElement).toBe(menuItem('Text'));
      expect(menuItem('Text').getAttribute('aria-checked')).toBe('true'); // current type
      for (const label of ['Duplicate', 'Move up', 'Move down', 'Copy link', 'Delete']) {
        expect(menuItem(label), label).toBeTruthy();
      }
    });

    it('moves through items with the arrow keys and closes with Escape back on the handle', async () => {
      await openMenu(1);
      const menu = element.querySelector<HTMLElement>('[role="menu"]')!;
      const key = (k: string) => menu.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
      key('ArrowDown');
      expect(document.activeElement).toBe(menuItem('Heading 1'));
      key('End');
      expect(document.activeElement).toBe(menuItem('Delete'));
      key('ArrowDown');
      expect(document.activeElement).toBe(menuItem('Text')); // wraps
      key('Escape');
      await stable();
      expect(element.querySelector('[role="menu"]')).toBeNull();
      expect(document.activeElement).toBe(grip());
    });

    it('Turn into changes the block', async () => {
      await openMenu(1);
      menuItem('Quote').click();
      await stable();
      expect((editor.getJSON() as JSONContent).content![1].type).toBe('blockquote');
      expect(element.querySelector('[role="menu"]')).toBeNull();
    });

    it('Duplicate copies the block', async () => {
      await openMenu(2);
      menuItem('Duplicate').click();
      await stable();
      expect(texts()).toEqual(['Plan', 'One', 'Two', 'Two', 'Three']);
      expect(element.querySelector('[role="status"]')!.textContent).toContain('Block duplicated');
    });

    it('Delete removes the block', async () => {
      await openMenu(2);
      menuItem('Delete').click();
      await stable();
      expect(texts()).toEqual(['Plan', 'One', 'Three']);
    });

    it('Move up/down reorder, and are disabled at the edges', async () => {
      await openMenu(0);
      expect(menuItem('Move up').disabled).toBe(true);
      menuItem('Move down').click();
      await stable();
      expect(texts()).toEqual(['One', 'Plan', 'Two', 'Three']);
    });

    it('a reorder is emitted as the new document, which autosave stores', async () => {
      await openMenu(3);
      menuItem('Move up').click();
      await stable();
      const last = stripIds(fixture.componentInstance.changes.at(-1)!);
      expect(last.content!.map((node) => node.content?.[0]?.text)).toEqual(['Plan', 'One', 'Three', 'Two']);
    });

    it('Copy link copies /p/<page>#block-<id> and gives the block an id', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      await openMenu(2);
      menuItem('Copy link').click();
      await stable();

      const id = (editor.getJSON() as JSONContent).content![2].attrs!['id'];
      expect(id).toBeTruthy();
      expect(writeText).toHaveBeenCalledWith(`${location.origin}/p/page-1#block-${id}`);
      expect(element.querySelector('[role="status"]')!.textContent).toContain('Link copied');
    });

    it('closes when clicking outside', async () => {
      await openMenu(1);
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      await stable();
      expect(element.querySelector('[role="menu"]')).toBeNull();
    });
  });

  describe('links to a block', () => {
    it('opening a #block-<id> link scrolls to and highlights that block', async () => {
      const scrolled: Element[] = [];
      const original = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (this: Element) {
        scrolled.push(this);
      };
      try {
        const withIds: JSONContent = {
          type: 'doc',
          content: [{ ...p('First'), attrs: { id: 'aaa' } }, { ...p('Target'), attrs: { id: 'bbb' } }],
        };
        await render(withIds, 'bbb');
        expect(scrolled.map((el) => el.getAttribute('data-id'))).toContain('bbb');
        expect(element.querySelector('[data-id="bbb"]')!.classList).toContain('tp-flash');
        expect(element.querySelector('[data-id="aaa"]')!.classList).not.toContain('tp-flash');
        expect(topBlockAt(editor, editor.state.selection.from)!.node.textContent).toBe('Target');
      } finally {
        Element.prototype.scrollIntoView = original;
      }
    });

    it('reveals the block when the link changes on an open page', async () => {
      const original = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = () => undefined;
      try {
        await render({
          type: 'doc',
          content: [{ ...p('First'), attrs: { id: 'aaa' } }, { ...p('Later'), attrs: { id: 'ccc' } }],
        });
        expect(element.querySelector('.tp-flash')).toBeNull();
        fixture.componentInstance.focusBlock.set('ccc');
        await stable();
        expect(element.querySelector('[data-id="ccc"]')!.classList).toContain('tp-flash');
      } finally {
        Element.prototype.scrollIntoView = original;
      }
    });

    it('keeps existing ids when loading saved content', async () => {
      await render({ type: 'doc', content: [{ ...p('Kept'), attrs: { id: 'keep-me' } }] });
      expect((editor.getJSON() as JSONContent).content![0].attrs!['id']).toBe('keep-me');
    });
  });
});
