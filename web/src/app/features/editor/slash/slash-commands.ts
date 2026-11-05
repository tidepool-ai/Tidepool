import { Editor, Range } from '@tiptap/core';
import type {} from '../images/image-upload'; // the pickImage command

export type SlashGroup = 'blocks' | 'ai' | 'embeds';
export type SlashTab = 'all' | SlashGroup;

export const SLASH_TABS: readonly { id: SlashTab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'blocks', label: 'Blocks' },
  { id: 'ai', label: 'AI' },
  { id: 'embeds', label: 'Embeds' },
];

export interface SlashCommand {
  id: string;
  title: string;
  description: string;
  /** Extra words people might type ("h1", "ul", "#"). */
  keywords: readonly string[];
  group: SlashGroup;
  /** Short label for the icon tile. */
  icon: string;
  /** Replace the "/query" text with this block. */
  run(editor: Editor, range: Range): void;
}

function setBlock(type: 'paragraph' | 'heading', attrs?: Record<string, unknown>) {
  return (editor: Editor, range: Range) => {
    editor.chain().focus().deleteRange(range).setNode(type, attrs).run();
  };
}

function list(type: 'bulletList' | 'orderedList' | 'taskList') {
  return (editor: Editor, range: Range) => {
    const chain = editor.chain().focus().deleteRange(range);
    // toggle* would lift the block out if it's already that kind of list.
    if (editor.isActive(type)) chain.run();
    else if (type === 'bulletList') chain.toggleBulletList().run();
    else if (type === 'orderedList') chain.toggleOrderedList().run();
    else chain.toggleTaskList().run();
  };
}

/** Run a block command on the current line after removing the "/query" text. */
function block(apply: (chain: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>) {
  return (editor: Editor, range: Range) => {
    apply(editor.chain().focus().deleteRange(range)).run();
  };
}

/** Blocks available today (FR-3). AI (T24) adds to its tab later. */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { id: 'text', title: 'Text', description: 'Plain paragraph', keywords: ['paragraph', 'plain', 'p'], group: 'blocks', icon: 'T', run: setBlock('paragraph') },
  { id: 'h1', title: 'Heading 1', description: 'Big section heading', keywords: ['h1', 'title', '#', 'large'], group: 'blocks', icon: 'H1', run: setBlock('heading', { level: 1 }) },
  { id: 'h2', title: 'Heading 2', description: 'Medium section heading', keywords: ['h2', 'subtitle', '##'], group: 'blocks', icon: 'H2', run: setBlock('heading', { level: 2 }) },
  { id: 'h3', title: 'Heading 3', description: 'Small section heading', keywords: ['h3', '###'], group: 'blocks', icon: 'H3', run: setBlock('heading', { level: 3 }) },
  { id: 'bullet', title: 'Bulleted list', description: 'A simple list', keywords: ['ul', 'unordered', 'bullet', 'list', '-'], group: 'blocks', icon: '•', run: list('bulletList') },
  { id: 'numbered', title: 'Numbered list', description: 'A list with numbers', keywords: ['ol', 'ordered', 'number', 'list', '1.'], group: 'blocks', icon: '1.', run: list('orderedList') },
  { id: 'todo', title: 'To-do list', description: 'Track tasks with checkboxes', keywords: ['todo', 'task', 'checkbox', 'check', '[]'], group: 'blocks', icon: '☐', run: list('taskList') },
  { id: 'toggle', title: 'Toggle', description: 'Hide content you can expand', keywords: ['details', 'collapse', 'fold', 'expand'], group: 'blocks', icon: '▸', run: block((chain) => chain.setDetails()) },
  { id: 'quote', title: 'Quote', description: 'Capture a quotation', keywords: ['blockquote', 'citation', '>'], group: 'blocks', icon: '“', run: block((chain) => chain.setBlockquote()) },
  { id: 'callout', title: 'Callout', description: 'Make a note stand out', keywords: ['note', 'info', 'tip', 'highlight', 'aside'], group: 'blocks', icon: '💡', run: block((chain) => chain.setCallout()) },
  { id: 'divider', title: 'Divider', description: 'A line between sections', keywords: ['hr', 'line', 'separator', 'rule', '---'], group: 'blocks', icon: '—', run: block((chain) => chain.setHorizontalRule()) },
  { id: 'code', title: 'Code', description: 'Code with syntax highlighting', keywords: ['code block', 'snippet', 'pre', '```'], group: 'blocks', icon: '</>', run: block((chain) => chain.setCodeBlock()) },
  {
    id: 'image', title: 'Image', description: 'Upload a picture (or paste one)', keywords: ['picture', 'photo', 'upload', 'img', 'png', 'jpg'], group: 'embeds', icon: '🖼',
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).run();
      editor.commands.pickImage();
    },
  },
];

/**
 * Commands in `tab` matching `query`, best first: title prefix, then a word in the title,
 * then a keyword, then anywhere in the title.
 */
export function filterCommands(
  query: string,
  tab: SlashTab,
  commands: readonly SlashCommand[] = SLASH_COMMANDS,
): SlashCommand[] {
  const inTab = tab === 'all' ? [...commands] : commands.filter((command) => command.group === tab);
  const q = query.trim().toLowerCase();
  if (!q) return inTab;
  const score = (command: SlashCommand): number => {
    const title = command.title.toLowerCase();
    if (title.startsWith(q)) return 0;
    if (title.split(/\s+/).some((word) => word.startsWith(q))) return 1;
    if (command.keywords.some((keyword) => keyword.toLowerCase().startsWith(q))) return 2;
    if (title.includes(q)) return 3;
    return -1;
  };
  return inTab
    .map((command, index) => ({ command, index, rank: score(command) }))
    .filter(({ rank }) => rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ command }) => command);
}
