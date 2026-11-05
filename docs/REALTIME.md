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
Vercel's rewrites don't carry WebSockets, so the web app connects to the API host directly.

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
- `page_docs` is separate from the REST `page_content` JSON for now; T15 moves the editor onto the
  live document.
