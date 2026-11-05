import { Extensions } from '@tiptap/core';
import { Details, DetailsContent, DetailsSummary } from '@tiptap/extension-details';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Callout } from './callout';
import { CodeBlock } from './code-block';

/** T11 blocks: to-do list, toggle, callout, code block. (Quote and divider come from StarterKit.) */
export function blockExtensions(): Extensions {
  return [
    TaskList,
    TaskItem.configure({
      nested: true,
      a11y: { checkboxLabel: (node, checked) => `${checked ? 'Done' : 'To do'}: ${node.textContent || 'empty item'}` },
    }),
    Details.configure({
      // Keep open/closed in the document, so a toggle stays open after a reload.
      persist: true,
      renderToggleButton: ({ element, isOpen }) => {
        element.setAttribute('aria-label', isOpen ? 'Collapse toggle' : 'Expand toggle');
        element.setAttribute('aria-expanded', String(isOpen));
      },
    }),
    DetailsSummary,
    DetailsContent,
    Callout,
    CodeBlock,
  ];
}
