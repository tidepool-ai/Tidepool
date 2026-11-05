import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { createLowlight } from 'lowlight';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import plaintext from 'highlight.js/lib/languages/plaintext';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

/** Languages offered in a code block's picker (a curated set keeps the editor chunk small). */
export const CODE_LANGUAGES: readonly { id: string; label: string }[] = [
  { id: 'plaintext', label: 'Plain text' },
  { id: 'bash', label: 'Bash' },
  { id: 'css', label: 'CSS' },
  { id: 'go', label: 'Go' },
  { id: 'xml', label: 'HTML' },
  { id: 'java', label: 'Java' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'json', label: 'JSON' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'python', label: 'Python' },
  { id: 'rust', label: 'Rust' },
  { id: 'sql', label: 'SQL' },
  { id: 'typescript', label: 'TypeScript' },
  { id: 'yaml', label: 'YAML' },
];

export const lowlight = createLowlight({
  plaintext,
  bash,
  css,
  go,
  xml,
  java,
  javascript,
  json,
  markdown,
  python,
  rust,
  sql,
  typescript,
  yaml,
});
// Let ```js, ```ts, ```html, ```sh ... pick the right language.
lowlight.registerAlias({
  javascript: ['js'],
  typescript: ['ts'],
  xml: ['html'],
  bash: ['sh', 'shell'],
  python: ['py'],
  yaml: ['yml'],
  markdown: ['md'],
});

/** Normalize a language name or alias to one of CODE_LANGUAGES (or plaintext). */
export function languageId(name: string | null | undefined): string {
  if (!name) return 'plaintext';
  const lower = name.toLowerCase();
  if (CODE_LANGUAGES.some((language) => language.id === lower)) return lower;
  const aliases: Record<string, string> = { js: 'javascript', ts: 'typescript', html: 'xml', sh: 'bash', shell: 'bash', py: 'python', yml: 'yaml', md: 'markdown' };
  return aliases[lower] ?? 'plaintext';
}

/**
 * Code block with syntax highlighting (lowlight) and a language picker above the code.
 * The picker is a plain <select> outside the editable content.
 */
export const CodeBlock = CodeBlockLowlight.extend({
  addNodeView() {
    return ({ node: initialNode, editor, getPos }) => {
      let node = initialNode;
      const dom = document.createElement('div');
      dom.className = 'tp-code';

      const header = document.createElement('div');
      header.className = 'tp-code-header';
      header.contentEditable = 'false';
      const select = document.createElement('select');
      select.className = 'tp-code-language';
      select.setAttribute('aria-label', 'Code language');
      for (const language of CODE_LANGUAGES) {
        const option = document.createElement('option');
        option.value = language.id;
        option.textContent = language.label;
        select.append(option);
      }
      select.value = languageId(node.attrs['language']);
      select.disabled = !editor.isEditable;
      select.addEventListener('change', () => {
        const pos = typeof getPos === 'function' ? getPos() : undefined;
        if (pos === undefined) return;
        editor.view.dispatch(editor.view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, language: select.value }));
        editor.commands.focus();
      });
      header.append(select);

      const pre = document.createElement('pre');
      const code = document.createElement('code');
      pre.append(code);
      dom.append(header, pre);

      const applyLanguage = () => {
        code.className = `language-${languageId(node.attrs['language'])}`;
        select.value = languageId(node.attrs['language']);
      };
      applyLanguage();

      return {
        dom,
        contentDOM: code,
        update: (updated) => {
          if (updated.type !== node.type) return false;
          node = updated;
          applyLanguage();
          select.disabled = !editor.isEditable;
          return true;
        },
        // The picker handles its own events and DOM; ProseMirror should leave it alone.
        stopEvent: (event) => header.contains(event.target as globalThis.Node),
        ignoreMutation: (mutation) => header.contains(mutation.target),
      };
    };
  },
}).configure({ lowlight, defaultLanguage: 'plaintext', enableTabIndentation: true, tabSize: 2 });
