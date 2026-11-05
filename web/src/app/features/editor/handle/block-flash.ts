import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export const blockFlashKey = new PluginKey<DecorationSet>('blockFlash');

/**
 * Briefly highlights a block (e.g. one opened from a link). A decoration rather than a class on the DOM,
 * because ProseMirror redraws block DOM and would drop the class.
 */
export const BlockFlash = Extension.create({
  name: 'blockFlash',
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: blockFlashKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set) {
            const meta = tr.getMeta(blockFlashKey) as { pos: number } | null | undefined;
            if (meta === null) return DecorationSet.empty;
            if (meta) {
              const node = tr.doc.nodeAt(meta.pos);
              return node
                ? DecorationSet.create(tr.doc, [Decoration.node(meta.pos, meta.pos + node.nodeSize, { class: 'tp-flash' })])
                : DecorationSet.empty;
            }
            return set.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations: (state) => blockFlashKey.getState(state),
        },
      }),
    ];
  },
});
