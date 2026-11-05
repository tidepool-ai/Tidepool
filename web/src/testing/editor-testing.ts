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
export function press(editor: Editor, key: string, modifiers: { ctrl?: boolean; shift?: boolean } = {}): boolean {
  const event = new KeyboardEvent('keydown', { key, ctrlKey: !!modifiers.ctrl, shiftKey: !!modifiers.shift, cancelable: true });
  const { view } = editor;
  return !!view.someProp('handleKeyDown', (f) => f(view, event));
}
