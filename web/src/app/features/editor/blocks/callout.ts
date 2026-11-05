import { Node, mergeAttributes } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    callout: {
      /** Wrap the current block(s) in a callout. */
      setCallout: () => ReturnType;
    };
  }
}

/**
 * A highlighted note with an emoji: <aside data-type="callout" role="note">.
 * Backspace at its start lifts the text out (ProseMirror's default for wrapping blocks).
 */
export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'paragraph+',
  defining: true,

  addAttributes() {
    return {
      emoji: {
        default: '💡',
        parseHTML: (element) => element.getAttribute('data-emoji') || '💡',
        renderHTML: (attributes) => ({ 'data-emoji': attributes['emoji'] }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'aside[data-type="callout"]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'aside',
      mergeAttributes(HTMLAttributes, { 'data-type': 'callout', class: 'tp-callout', role: 'note' }),
      ['span', { class: 'tp-callout-emoji', contenteditable: 'false', 'aria-hidden': 'true' }, node.attrs['emoji']],
      ['div', { class: 'tp-callout-body' }, 0],
    ];
  },

  addCommands() {
    return {
      setCallout:
        () =>
        ({ commands }) =>
          commands.wrapIn(this.name),
    };
  },

});
