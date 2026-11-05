# Realtime (live page documents)

The API serves each page's live document over a WebSocket (T14). The web app's collaboration
layer (T15) connects to it with Yjs' `WebsocketProvider`.

## Connecting

1. `POST /api/pages/{id}/realtime-ticket` (with the access token) returns
   `{ "ticket": "…", "expires_in": 60, "url": "/ws/pages/{id}" }`.
2. Open `wss://<api host>/ws/pages/{id}?ticket=<ticket>`. With `y-websocket`:
   `new WebsocketProvider('wss://<api host>/ws/pages', pageId, doc, { params: { ticket } })`.

A ticket is good for one page for a minute, so get a fresh one before every (re)connect. Browsers
can't send headers on a WebSocket; the short ticket keeps the access token out of URLs and logs.
Vercel's rewrites don't carry WebSockets, so the web app connects to the API host directly: the
ticket's `url` is absolute (`wss://…`) when the API knows its public address (`PUBLIC_API_URL`, or
`RENDER_EXTERNAL_URL`, which Render sets by itself), and a plain path otherwise (local dev, where
`ng serve` forwards `/ws`).

## In the web app (T15)

- `core/collab/collab-connection.ts` wraps `y-websocket`'s provider: a fresh ticket per connect,
  close codes 4403 and 1009 are final, a resync every 10 s keeps quiet pages from looking dead, and
  the state (`connecting`, `connected`, `offline`, `closed`) is exposed as signals.
- The page waits for the first sync before showing the editor. A page whose live document has
  never been written gets its old REST JSON copied in once. Every tab builds that copy as the same
  Yjs client from the same JSON, so two tabs doing it at once still end up with one copy.
- Pages in the trash show a read-only snapshot and disconnect, so nothing is ever sent for them.
- Edits made offline stay in the tab's document and are sent on reconnect; leaving the page while
  some haven't reached the server asks for confirmation.
- Presence: each tab shares `{ user: { id, name } }`; the top of the page shows everyone else,
  once per person.
- `KeepCaret` (`features/editor/collab/keep-caret.ts`) works around a y-tiptap heuristic that puts
  your caret back at its old offset when someone else edits the same block.

## Protocol

The y-websocket protocol: Yjs sync (step 1, step 2, update) and awareness (presence) messages, as
binary frames. Content lives wherever the client puts it in the shared `Y.Doc` (Tiptap's
collaboration extension uses the `default` XML fragment); the server only merges and relays.

- On connect the server sends its sync step 1 and the current presence of others.
- Every message that would change the document re-checks the caller's access to the page.
- Presence (awareness) is relayed to everyone in the room, readers included, and cleared when a
  client disconnects.

## Close codes

| Code | Meaning | What the client should do |
| --- | --- | --- |
| `4401` | Ticket missing, expired or for another page | Get a new ticket and reconnect |
| `4403` | No access to the page, or it's read-only (in the trash) and an edit was sent | Stop; show the page read-only or as missing |
| `1009` | Message over `MAX_REALTIME_MESSAGE_BYTES` | Stop; the edit is too big |
| `1012` | Server restarting | Reconnect (with a new ticket) |
| `1013` | Client fell too far behind | Reconnect |

## Storage and scaling

- Each open page has one room per API worker, holding the merged `Y.Doc`. The state is saved to
  `page_docs` 2 seconds after the last edit (at least every 10 seconds while editing), when the
  last client leaves, and on shutdown. Saves merge with what's stored, so a worker that missed an
  update never drops it, and every save is a compacted snapshot.
- With `REDIS_URL` set, workers share updates and presence through Redis pub/sub (one channel per
  page). A worker that opens a page asks the others for edits that aren't saved yet. Without
  Redis, run a single worker (the Render setup does).
- Since T15 the editor only edits the live document; the REST `page_content` JSON is read once, to
  copy pages saved before live editing.
