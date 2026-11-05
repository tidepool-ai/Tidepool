import { Extension } from '@tiptap/core';
import { Plugin, TextSelection } from '@tiptap/pm/state';
import { absolutePositionToRelativePosition, relativePositionToAbsolutePosition, ySyncPluginKey } from '@tiptap/y-tiptap';
import * as Y from 'yjs';

interface SavedCaret {
  anchor: Y.RelativePosition;
  head: Y.RelativePosition;
}

/**
 * Keeps your caret on the text it was on when someone else edits the same block.
 *
 * y-tiptap remembers the caret as Yjs relative positions, but then "recovers" it with a block
 * matching heuristic that, for blocks with an id (all of ours), puts it back at the old offset
 * when the block's text changed: typing on would land in the wrong place. This records the
 * caret before each Yjs change and, after a remote one, puts it where those positions resolve.
 */
export const KeepCaret = Extension.create<{ document: Y.Doc | null }>({
  name: 'keepCaret',

  addOptions() {
    return { document: null };
  },

  addProseMirrorPlugins() {
    const ydoc = this.options.document;
    if (!ydoc) return [];
    const editor = this.editor;
    let saved: SavedCaret | null = null;

    const capture = () => {
      saved = null;
      if (editor.isDestroyed) return;
      const binding = ySyncPluginKey.getState(editor.state)?.binding;
      const selection = editor.state.selection;
      if (!binding || !(selection instanceof TextSelection)) return;
      saved = {
        anchor: absolutePositionToRelativePosition(selection.anchor, binding.type, binding.mapping),
        head: absolutePositionToRelativePosition(selection.head, binding.type, binding.mapping),
      };
    };
    ydoc.on('beforeAllTransactions', capture);

    return [
      new Plugin({
        appendTransaction(transactions, _old, state) {
          const remote = transactions.some((tr) => {
            const meta = tr.getMeta(ySyncPluginKey);
            return tr.docChanged && meta?.isChangeOrigin && !meta.isUndoRedoOperation;
          });
          const binding = ySyncPluginKey.getState(state)?.binding;
          if (!remote || !saved || !binding || !(state.selection instanceof TextSelection)) return null;
          const anchor = relativePositionToAbsolutePosition(binding.doc, binding.type, saved.anchor, binding.mapping);
          const head = relativePositionToAbsolutePosition(binding.doc, binding.type, saved.head, binding.mapping);
          if (anchor === null || head === null) return null;
          if (state.selection.anchor === anchor && state.selection.head === head) return null;
          const max = state.doc.content.size;
          if (anchor < 0 || head < 0 || anchor > max || head > max) return null;
          const selection = TextSelection.between(state.doc.resolve(anchor), state.doc.resolve(head));
          return state.tr.setSelection(selection).setMeta('addToHistory', false);
        },
        view: () => ({ destroy: () => ydoc.off('beforeAllTransactions', capture) }),
      }),
    ];
  },
});
