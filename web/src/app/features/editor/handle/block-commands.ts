import { Editor } from '@tiptap/core';
import { Node as PmNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { SLASH_COMMANDS, SlashCommand } from '../slash/slash-commands';

/** Block types that get a stable id (used for links to a block). */
export const BLOCK_ID_TYPES = [
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'taskList',
  'blockquote',
  'callout',
  'codeBlock',
  'horizontalRule',
  'details',
  'image',
];

export interface TopBlock {
  /** Position right before the block. */
  pos: number;
  node: PmNode;
  index: number;
}

/** The top-level block containing `pos` (a document position), if any. */
export function topBlockAt(editor: Editor, pos: number): TopBlock | null {
  const { doc } = editor.state;
  if (pos < 0 || pos > doc.content.size) return null;
  const $pos = doc.resolve(pos);
  if ($pos.depth === 0) {
    // Between blocks (e.g. a node selection on a divider): take the block that starts here.
    const node = doc.nodeAt(pos);
    return node ? { pos, node, index: $pos.index(0) } : null;
  }
  const start = $pos.before(1);
  return { pos: start, node: doc.nodeAt(start)!, index: $pos.index(0) };
}

/** The top-level block holding the selection. */
export function selectedBlock(editor: Editor): TopBlock | null {
  return topBlockAt(editor, editor.state.selection.from);
}

/** Readable name of a block, for labels ("Heading 2", "To-do list"). */
export function blockName(node: PmNode): string {
  switch (node.type.name) {
    case 'heading':
      return `Heading ${node.attrs['level']}`;
    case 'paragraph':
      return 'Text';
    case 'bulletList':
      return 'Bulleted list';
    case 'orderedList':
      return 'Numbered list';
    case 'taskList':
      return 'To-do list';
    case 'blockquote':
      return 'Quote';
    case 'callout':
      return 'Callout';
    case 'codeBlock':
      return 'Code';
    case 'horizontalRule':
      return 'Divider';
    case 'details':
      return 'Toggle';
    case 'image':
      return 'Image';
    default:
      return 'Block';
  }
}

/** Move the block one place up (-1) or down (+1). Returns false at the edge. */
export function moveBlock(editor: Editor, pos: number, direction: -1 | 1): boolean {
  const block = topBlockAt(editor, pos);
  if (!block) return false;
  const { doc } = editor.state;
  const targetIndex = block.index + direction;
  if (targetIndex < 0 || targetIndex >= doc.childCount) return false;
  const neighbour = doc.child(targetIndex);
  const tr = editor.state.tr.delete(block.pos, block.pos + block.node.nodeSize);
  const insertAt = direction === -1 ? block.pos - neighbour.nodeSize : block.pos + neighbour.nodeSize;
  tr.insert(insertAt, block.node);
  tr.setSelection(TextSelection.near(tr.doc.resolve(insertAt + 1)));
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

/** Insert a copy right after the block (with a new id). */
export function duplicateBlock(editor: Editor, pos: number): boolean {
  const block = topBlockAt(editor, pos);
  if (!block) return false;
  const copy = block.node.type.create({ ...block.node.attrs, id: null }, block.node.content, block.node.marks);
  const after = block.pos + block.node.nodeSize;
  const tr = editor.state.tr.insert(after, copy);
  tr.setSelection(TextSelection.near(tr.doc.resolve(after + 1)));
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

/** Delete the block. The last block becomes an empty paragraph instead (a page always has one). */
export function deleteBlock(editor: Editor, pos: number): boolean {
  const block = topBlockAt(editor, pos);
  if (!block) return false;
  const { state } = editor;
  const tr = state.tr;
  if (state.doc.childCount === 1) {
    tr.replaceWith(block.pos, block.pos + block.node.nodeSize, state.schema.nodes['paragraph'].create());
  } else {
    tr.delete(block.pos, block.pos + block.node.nodeSize);
  }
  const at = Math.min(block.pos, tr.doc.content.size);
  tr.setSelection(TextSelection.near(tr.doc.resolve(at)));
  editor.view.dispatch(tr);
  return true;
}

/** What a block can be turned into: the text blocks of the slash menu (not divider). */
export const TURN_INTO: readonly SlashCommand[] = SLASH_COMMANDS.filter(
  (command) => command.group === 'blocks' && command.id !== 'divider',
);

/** Turn the block into another kind, keeping its text. */
export function turnInto(editor: Editor, pos: number, commandId: string): boolean {
  const block = topBlockAt(editor, pos);
  const command = TURN_INTO.find((c) => c.id === commandId);
  if (!block || !command || block.node.isLeaf) return false;
  // Put the caret in the block's first text, then run the same command the slash menu uses.
  const inside = TextSelection.near(editor.state.doc.resolve(block.pos + 1));
  editor.view.dispatch(editor.state.tr.setSelection(inside));
  command.run(editor, { from: inside.from, to: inside.from });
  return true;
}

/** Make sure the block has an id and return it (ids are filled in by UniqueID on change). */
export function ensureBlockId(editor: Editor, pos: number): string | null {
  const block = topBlockAt(editor, pos);
  if (!block) return null;
  let id = block.node.attrs['id'] as string | null;
  if (!id) {
    id = crypto.randomUUID();
    editor.view.dispatch(editor.state.tr.setNodeAttribute(block.pos, 'id', id));
  }
  return id;
}

/** Hash used in a link to a block: /p/<page>#block-<id>. */
export function blockHash(id: string): string {
  return `block-${id}`;
}
