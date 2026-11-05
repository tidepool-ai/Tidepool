import { Editor, Extension } from '@tiptap/core';
import { Plugin, PluginKey, Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet, EditorView } from '@tiptap/pm/view';
import { IMAGE_TYPES, ImageUploader, UploadError } from '../../../core/files/image-upload';

/** An image being uploaded. It isn't in the document until it's done, so autosave never stores half an upload. */
export interface Upload {
  id: string;
  /** Where the image goes: a position between top-level blocks, kept up to date as the document changes. */
  pos: number;
  file: File;
  /** 0..100 */
  percent: number;
  error: string | null;
  retryable: boolean;
}

type Action =
  | { add: Upload[] }
  | { progress: { id: string; percent: number } }
  | { fail: { id: string; message: string; retryable: boolean } }
  | { retry: string }
  | { remove: string; landed?: number };

export const imageUploadKey = new PluginKey<Upload[]>('imageUpload');

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    imageUpload: {
      /** Upload images and insert each one when it's done; `pos` defaults to next to the caret. */
      uploadImages: (files: File[], pos?: number) => ReturnType;
      /** Open the file picker, then upload what was picked. */
      pickImage: () => ReturnType;
    };
  }
}

export interface ImageUploadOptions {
  /** Read on every upload, so the page can provide it later; null turns uploads off. */
  uploader: () => ImageUploader | null;
}

/** The uploads in progress or failed, in order. */
export function uploadsOf(editor: Editor): Upload[] {
  return imageUploadKey.getState(editor.state) ?? [];
}

/** Next to the caret: before an empty line (so typing goes on below), otherwise after the block. */
function defaultPos(tr: Transaction): number {
  const { $from } = tr.selection;
  if ($from.depth === 0) return $from.pos;
  const block = $from.node(1);
  return block.type.name === 'paragraph' && block.content.size === 0 ? $from.before(1) : $from.after(1);
}

/** The gap between blocks closest to where something was dropped. */
function dropPos(view: EditorView, event: DragEvent): number | null {
  const found = view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (!found) return null;
  const $pos = view.state.doc.resolve(found.pos);
  if ($pos.depth === 0) return found.pos;
  const dom = view.nodeDOM($pos.before(1));
  if (dom instanceof HTMLElement) {
    const rect = dom.getBoundingClientRect();
    if (event.clientY < rect.top + rect.height / 2) return $pos.before(1);
  }
  return $pos.after(1);
}

function fileName(file: File): string {
  return file.name || 'image';
}

/** Alt text until people can edit it: the file name without its extension. */
function altText(file: File): string {
  return fileName(file).replace(/\.[a-z0-9]+$/i, '');
}

let nextId = 0;

function send(editor: Editor, action: Action): void {
  if (!editor.isDestroyed) {
    editor.view.dispatch(editor.state.tr.setMeta(imageUploadKey, action).setMeta('addToHistory', false));
  }
}

/** Run (or rerun) the upload with this id: progress, then the image block, or the error. */
function startUpload(editor: Editor, id: string, uploader: ImageUploader | null): void {
  const upload = uploadsOf(editor).find((u) => u.id === id);
  if (!upload || !uploader) return;
  uploader(upload.file, (fraction) => {
    const percent = Math.round(Math.min(Math.max(fraction, 0), 1) * 100);
    const current = uploadsOf(editor).find((u) => u.id === id);
    if (current && current.percent !== percent) send(editor, { progress: { id, percent } });
  }).then(
    (src) => {
      if (editor.isDestroyed) return;
      const current = uploadsOf(editor).find((u) => u.id === id);
      if (!current) return; // removed meanwhile
      const image = editor.schema.nodes['image'].create({ src, alt: altText(current.file) });
      const tr = editor.state.tr
        .insert(current.pos, image)
        .setMeta(imageUploadKey, { remove: id, landed: current.pos } satisfies Action);
      editor.view.dispatch(tr);
    },
    (error: unknown) => {
      const message = error instanceof UploadError ? error.message : "Couldn't upload the image. Try again.";
      const retryable = error instanceof UploadError ? error.retryable : true;
      send(editor, { fail: { id, message, retryable } });
    },
  );
}

/**
 * Paste, drop or pick images (FR-10, T13). Each one shows a placeholder with its progress where it
 * will appear, becomes an image block once uploaded, or shows what went wrong with Try again / Remove.
 */
export const ImageUpload = Extension.create<ImageUploadOptions>({
  name: 'imageUpload',

  addOptions() {
    return { uploader: () => null };
  },

  addCommands() {
    return {
      uploadImages:
        (files, pos) =>
        ({ editor, tr, dispatch }) => {
          if (!editor.isEditable || !this.options.uploader() || files.length === 0) return false;
          if (dispatch) {
            const at = pos ?? defaultPos(tr);
            const uploads = files.map((file) => ({
              id: `upload-${++nextId}`,
              pos: at,
              file,
              percent: 0,
              error: null,
              retryable: true,
            }));
            tr.setMeta(imageUploadKey, { add: uploads } satisfies Action).setMeta('addToHistory', false);
            // Start once this transaction is applied, so progress updates never race it.
            queueMicrotask(() => uploads.forEach((upload) => startUpload(editor, upload.id, this.options.uploader())));
          }
          return true;
        },
      pickImage:
        () =>
        ({ editor }) => {
          if (!editor.isEditable || !this.options.uploader()) return false;
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = IMAGE_TYPES.join(',');
          input.multiple = true;
          input.addEventListener('change', () => {
            const files = Array.from(input.files ?? []);
            if (files.length) editor.commands.uploadImages(files);
          });
          input.click();
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    const hasUploader = () => !!this.options.uploader();
    const act = (action: Action) => send(editor, action);
    const handlers = {
      retry: (id: string) => {
        act({ retry: id });
        startUpload(editor, id, this.options.uploader());
      },
      remove: (id: string) => {
        act({ remove: id });
        editor.commands.focus();
      },
    };

    return [
      new Plugin<Upload[]>({
        key: imageUploadKey,
        state: {
          init: () => [],
          apply(tr, uploads) {
            const action = tr.getMeta(imageUploadKey) as Action | undefined;
            // An image that lands where other uploads wait goes after the ones started before it,
            // so several images at one spot keep the order they were added in.
            const landed = action && 'remove' in action ? uploads.findIndex((u) => u.id === action.remove) : -1;
            const at = action && 'remove' in action ? action.landed : undefined;
            let next = tr.docChanged
              ? uploads.map((u, i) => ({ ...u, pos: tr.mapping.map(u.pos, i < landed && u.pos === at ? -1 : 1) }))
              : uploads;
            if (!action) return next;
            if ('add' in action) next = [...next, ...action.add];
            else if ('progress' in action) {
              next = next.map((u) => (u.id === action.progress.id ? { ...u, percent: action.progress.percent } : u));
            } else if ('fail' in action) {
              const { id, message, retryable } = action.fail;
              next = next.map((u) => (u.id === id ? { ...u, error: message, retryable } : u));
            } else if ('retry' in action) {
              next = next.map((u) => (u.id === action.retry ? { ...u, error: null, percent: 0 } : u));
            } else next = next.filter((u) => u.id !== action.remove);
            return next;
          },
        },
        props: {
          decorations(state) {
            const uploads = imageUploadKey.getState(state) ?? [];
            if (!uploads.length) return null;
            return DecorationSet.create(
              state.doc,
              uploads.map((upload) =>
                Decoration.widget(upload.pos, () => renderUpload(upload, handlers), {
                  // A new key redraws the placeholder when its progress or error changes.
                  key: `${upload.id}:${upload.percent}:${upload.error ?? ''}`,
                  stopEvent: () => true,
                  ignoreSelection: true,
                }),
              ),
            );
          },
          handlePaste(view, event) {
            const files = Array.from(event.clipboardData?.files ?? []);
            if (!files.length || !hasUploader() || !view.editable) return false;
            return editor.commands.uploadImages(files);
          },
          handleDrop(view, event, _slice, moved) {
            const files = Array.from(event.dataTransfer?.files ?? []);
            if (moved || !files.length || !hasUploader() || !view.editable) return false;
            const pos = dropPos(view, event);
            if (pos === null) return false;
            event.preventDefault();
            return editor.commands.uploadImages(files, pos);
          },
        },
      }),
    ];
  },
});

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const el = document.createElement(tag);
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

/** The placeholder: name and progress bar while uploading; the reason and actions when it failed. */
function renderUpload(
  upload: Upload,
  handlers: { retry: (id: string) => void; remove: (id: string) => void },
): HTMLElement {
  const name = fileName(upload.file);
  const root = element('div', 'tp-upload');
  root.contentEditable = 'false';
  root.dataset['uploadId'] = upload.id;
  root.dataset['state'] = upload.error ? 'error' : 'uploading';

  const body = element('div', 'tp-upload-body');
  body.append(element('span', 'tp-upload-name', name));
  root.append(body);

  if (upload.error) {
    const message = element('p', 'tp-upload-error', `Couldn't upload ${name}. ${upload.error}`);
    message.setAttribute('role', 'alert');
    body.append(message);
    const actions = element('div', 'tp-upload-actions');
    if (upload.retryable) {
      const retry = element('button', 'tp-upload-button', 'Try again');
      retry.type = 'button';
      retry.setAttribute('aria-label', `Try uploading ${name} again`);
      retry.addEventListener('click', () => handlers.retry(upload.id));
      actions.append(retry);
    }
    const remove = element('button', 'tp-upload-button', 'Remove');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove ${name}`);
    remove.addEventListener('click', () => handlers.remove(upload.id));
    actions.append(remove);
    root.append(actions);
    return root;
  }

  const track = element('div', 'tp-upload-track');
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-label', `Uploading ${name}`);
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', '100');
  track.setAttribute('aria-valuenow', String(upload.percent));
  const bar = element('span', 'tp-upload-bar');
  bar.style.width = `${upload.percent}%`;
  track.append(bar);
  body.append(track);
  root.append(element('span', 'tp-upload-percent', `${upload.percent}%`));
  return root;
}
