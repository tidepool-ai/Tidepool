import { Extension } from '@tiptap/core';
import { moveBlock } from './block-commands';

/** Keyboard reordering, so moving blocks never needs a mouse: Alt+Shift+↑ / Alt+Shift+↓. */
export const BlockKeys = Extension.create({
  name: 'blockKeys',
  addKeyboardShortcuts() {
    return {
      'Alt-Shift-ArrowUp': ({ editor }) => moveBlock(editor, editor.state.selection.from, -1),
      'Alt-Shift-ArrowDown': ({ editor }) => moveBlock(editor, editor.state.selection.from, 1),
    };
  },
});
