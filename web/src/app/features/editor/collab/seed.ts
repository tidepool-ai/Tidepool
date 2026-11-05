import { Extensions, JSONContent, getSchema } from '@tiptap/core';
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import * as Y from 'yjs';

/** Where Tiptap's collaboration extension keeps the document in the Y.Doc. */
export const COLLAB_FIELD = 'default';

/** Whether the live document has never been written to (a page saved only as JSON before T15). */
export function isBlank(doc: Y.Doc): boolean {
  return doc.store.clients.size === 0;
}

/**
 * Copy a page saved as JSON (before live editing) into its live document, once.
 *
 * Every tab builds the copy as the same client (id 0) from the same JSON, so tabs that open the page
 * at the same moment produce identical changes, and Yjs keeps one copy instead of two.
 */
export function seedFromJson(doc: Y.Doc, json: JSONContent, extensions: Extensions): boolean {
  if (!isBlank(doc) || !json.content?.length) return false;
  const seed = new Y.Doc();
  seed.clientID = 0;
  prosemirrorJSONToYXmlFragment(getSchema(extensions), json, seed.getXmlFragment(COLLAB_FIELD));
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed), 'seed');
  seed.destroy();
  return true;
}

/** The live document as Tiptap JSON (for a read-only snapshot). */
export function docToJson(doc: Y.Doc): JSONContent {
  return yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(COLLAB_FIELD)) as JSONContent;
}
