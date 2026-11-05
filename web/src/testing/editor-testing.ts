import { Editor } from '@tiptap/core';

/** Type like a user: each character goes through ProseMirror's text input path, so input rules fire. */
export function type(editor: Editor, text: string): void {
  const { view } = editor;
  for (const char of text) {
    const { from, to } = view.state.selection;
    const handled = view.someProp('handleTextInput', (f) => f(view, from, to, char, () => view.state.tr.insertText(char, from, to)));
    if (!handled) view.dispatch(view.state.tr.insertText(char, from, to));
  }
}

/** Press a key through the editor's plugins and keymaps (Mod = Ctrl here). Returns true if handled. */
export function press(
  editor: Editor,
  key: string,
  modifiers: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {},
): boolean {
  const event = new KeyboardEvent('keydown', {
    key,
    ctrlKey: !!modifiers.ctrl,
    shiftKey: !!modifiers.shift,
    altKey: !!modifiers.alt,
    cancelable: true,
  });
  const { view } = editor;
  return !!view.someProp('handleKeyDown', (f) => f(view, event));
}

/**
 * The document without block ids (UniqueID adds a random `id` to each block), so tests can compare
 * structure. Attributes left empty are dropped.
 */
export function stripIds<T>(json: T): T {
  if (Array.isArray(json)) return json.map(stripIds) as T;
  if (!json || typeof json !== 'object') return json;
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(json as Record<string, unknown>)) {
    if (key === 'attrs' && value && typeof value === 'object') {
      const rest = Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([name]) => name !== 'id'));
      if (Object.keys(rest).length) copy[key] = rest;
    } else {
      copy[key] = stripIds(value);
    }
  }
  return copy as T;
}
