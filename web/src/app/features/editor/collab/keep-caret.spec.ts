import { Editor } from '@tiptap/core';
import * as Y from 'yjs';
import { stubLayoutForProseMirror } from '../../../../testing/prosemirror-jsdom';
import { editorExtensions } from '../editor';

/** Two editors on two linked Y.Docs, like two people on one page. */
function twoPeople() {
  const mine = new Y.Doc();
  const theirs = new Y.Doc();
  mine.on('update', (update: Uint8Array, origin: unknown) => origin !== 'net' && Y.applyUpdate(theirs, update, 'net'));
  theirs.on('update', (update: Uint8Array, origin: unknown) => origin !== 'net' && Y.applyUpdate(mine, update, 'net'));
  const make = (doc: Y.Doc) => {
    const element = document.createElement('div');
    document.body.append(element);
    return new Editor({ element, extensions: editorExtensions('', null, () => null, doc) });
  };
  return { me: make(mine), them: make(theirs) };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('KeepCaret: my caret stays on my text while others edit (T15)', () => {
  let me: Editor;
  let them: Editor;

  beforeAll(() => stubLayoutForProseMirror());
  beforeEach(async () => {
    ({ me, them } = twoPeople());
    await tick(); // block ids are filled in just after creation
  });
  afterEach(() => {
    me.destroy();
    them.destroy();
  });

  it('moves with the text when someone types before it in the same block', async () => {
    me.commands.focus();
    me.commands.insertContent('Hello world');
    expect(me.state.selection.from).toBe(12);
    them.commands.insertContentAt(1, 'Start: ');
    await tick();
    expect(me.state.selection.from).toBe(19);
    me.commands.insertContent('!');
    expect(me.state.doc.textContent).toBe('Start: Hello world!');
  });

  it('stays put when someone types after it', async () => {
    me.commands.focus();
    me.commands.insertContent('Hello world');
    me.commands.setTextSelection(6);
    them.commands.insertContentAt(12, ' again');
    await tick();
    expect(me.state.selection.from).toBe(6);
  });

  it('keeps a selected range on the same words', async () => {
    me.commands.focus();
    me.commands.insertContent('Hello world');
    me.commands.setTextSelection({ from: 7, to: 12 }); // "world"
    them.commands.insertContentAt(1, 'Oh, ');
    await tick();
    const { from, to } = me.state.selection;
    expect(me.state.doc.textBetween(from, to)).toBe('world');
  });

  it('follows its block when someone adds a block above', async () => {
    me.commands.focus();
    me.commands.insertContent('Mine');
    them.commands.insertContentAt(0, { type: 'paragraph', content: [{ type: 'text', text: 'Theirs' }] });
    await tick();
    me.commands.insertContent('!');
    expect(me.getText({ blockSeparator: '|' })).toBe('Theirs|Mine!');
  });
});
