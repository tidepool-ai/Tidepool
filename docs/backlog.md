# Tidepool backlog

One task = one branch = one PR. Take the lowest unchecked ID unless told otherwise, and tick it in the same PR.
Each task lists what must be true when it's done. Specs: `docs/PRD.md` (FR-IDs) and `docs/DESIGN-SYSTEM.md`.

## Phase 0: Foundations

- [x] **T00 Scaffold**: Angular app in `web/`, FastAPI in `api/`, CI, CLAUDE.md.
- [x] **T01 Database setup (api)**: Async SQLAlchemy 2 + Alembic + PostgreSQL. Add `docker-compose.yml` with Postgres 16. CI `api` job gets a Postgres service.
  - Done when: `alembic upgrade head` runs; a pytest fixture gives each test a clean DB; `/health` reports DB status.
- [x] **T02 Auth (api)**: User model; email magic-link sign-in (link logged to console in dev); JWT access token (15 min) + rotating refresh token in an httpOnly cookie. Routes under `/api/auth`.
  - Done when: tests cover request link, verify link, refresh, logout, expired and reused tokens.
- [x] **T03 Theme service (web)**: All 5 schemes x light/dark tokens from DESIGN-SYSTEM.md section 5; `ThemeService` (signals) with scheme, mode (light/dark/system), text size, high contrast; saved to localStorage; no-flash script in `index.html`.
  - Done when: unit tests cover each setting and system-mode switching; contrast test asserts section 5.7 ratios.
- [x] **T04 App shell (web)**: Icon rail + spaces panel + main outlet per the Home design; routes `/login`, `/home`, `/p/:pageId`, `/settings/appearance` (lazy); auth guard; login page calling T02.
  - Done when: guard redirects signed-out users; shell is keyboard navigable; skip link present.
- [x] **T05 Workspaces (api)**: Workspace and member (owner/admin/member/guest) models; a personal workspace created on first sign-in; `GET /api/workspaces`, `GET /api/workspaces/{id}/members`.
  - Done when: tests cover creation and that members only see their workspaces.
- [x] **T06 Pages API (api)**: Page model (parent_id, ltree path, title, icon, cover, archived_at); create, get, rename, move, trash, restore; `GET /api/pages/{id}/children` (one level).
  - Done when: tests cover nesting, moving a subtree, trash/restore and access checks.
- [x] **T07 Sidebar page tree (web)**: Lazy-loaded tree in the spaces panel; create page, rename inline, expand/collapse, trash; active page highlighted.
  - Done when: component tests cover create/rename/expand; works with keyboard.

## Phase 1: Editor

- [x] **T08 Editor core (web)**: Tiptap (ProseMirror) wrapped in an Angular component at `/p/:pageId`; title + paragraph, H1–H3, bulleted, numbered lists; content saved as JSON.
  - Done when: typing, undo/redo and lists work; unit tests for the wrapper.
- [x] **T09 Save content (api + web)**: `GET/PUT /api/pages/{id}/content` (JSON); debounced autosave (1 s) with a "Saved" indicator.
  - Done when: reload restores content; API tests cover permissions and size limit.
- [x] **T10 Slash menu (web)**: `/` opens the menu (All, Blocks, AI, Embeds tabs), filters as you type, Up/Down/Enter/Esc, inserts the block.
  - Done when: tests cover filtering and keyboard selection.
- [x] **T11 More blocks (web)**: To-do, toggle, quote, callout, divider, code (with language + highlighting); Markdown shortcuts per FR-5.
  - Done when: each shortcut has a test.
- [x] **T12 Block handle (web)**: Hover handle with drag-to-reorder and block menu (turn into, duplicate, delete, copy link).
  - Done when: reorder persists; menu actions tested.
- [x] **T13 Images (api + web)**: `POST /api/files/presign` (S3/MinIO, 25 MB limit, image types only); paste or upload image into the editor.
  - Done when: API validates type/size; editor shows upload progress and error state.

## Phase 2: Realtime

- [ ] **T14 Realtime service (api)**: `WS /ws/pages/{id}` speaking the Yjs sync protocol with pycrdt; room per page; state persisted (debounced 2 s) to `page_docs`; Redis pub/sub between workers.
  - Done when: two clients converge in a test; permission checked on connect and on each update.
- [ ] **T15 Collaborative editing (web)**: y-prosemirror binding replaces REST saving for content; presence avatars in the top bar.
  - Done when: two browser tabs edit the same page live; reconnect after offline works.

## Phase 3: Databases

- [ ] **T16 Database API (api)**: Database schema (property definitions), rows as pages with properties; `POST /api/databases/{id}/query` with filters, sorts and cursor pagination; views stored per database.
  - Done when: tests cover the 10 MVP property types, filter operators and pagination.
- [ ] **T17 Table lens (web)**: Table with inline cell editing, add row, add/rename/retype property, CDK virtual scroll.
  - Done when: 10k rows scroll smoothly in a perf test; editing tested.
- [ ] **T18 Board lens (web)**: Columns grouped by Status/Select; drag cards between columns updates the property; column counts.
  - Done when: drag and keyboard move tested.
- [ ] **T19 Row side peek (web)**: Opens a row as a side panel with properties on top and the editor below; open as full page.
  - Done when: URL reflects the open row; Esc closes.
- [ ] **T20 Filters and sorts UI (web)**: Filter chips, sort menu, saved per view.
  - Done when: settings persist per view and reload correctly.

## Phase 4: Sharing, search, AI

- [ ] **T21 Permissions + Share dialog (api + web)**: Page access levels (full, edit, comment, view) inherited down the tree; invite by email; link access (invited only / workspace / public).
  - Done when: API tests cover inheritance and overrides; dialog matches the design.
- [ ] **T22 Command bar (api + web)**: Cmd/Ctrl+K palette; title search API respecting permissions; recent pages when empty; actions (new page, create task).
  - Done when: keyboard-only flow tested; results never include pages the user can't open.
- [ ] **T23 AI service (api)**: `app/ai/` module using the `openai` SDK with `GLM_BASE_URL`/`GLM_API_KEY`/`GLM_MODEL`; `POST /api/ai/complete` streams SSE; per-user daily token quota; usage log.
  - Done when: tests use a fake OpenAI-compatible server; quota and timeout paths tested.
- [ ] **T24 Ask AI draft (web)**: Space on an empty line or `/ai` opens the prompt; streams into a draft block; Stop, Retry, Discard, Insert; thumbs feedback; "AI-generated" label.
  - Done when: streaming and each action tested with a mocked SSE stream.
- [ ] **T25 Rewrite selection (web)**: Toolbar Ask AI chips (clearer, shorter, friendlier, fix grammar, translate); diff view with Accept/Reject.
  - Done when: accept applies the change as one undo step.
- [ ] **T26 Appearance settings (api + web)**: Settings > Appearance page per design; `GET/PATCH /api/me/preferences/appearance`; workspace default for admins.
  - Done when: preference syncs across reload and devices; precedence user > workspace > default tested.
- [ ] **T27 Markdown export (api)**: Export a page and its sub-pages as a Markdown + assets zip.
  - Done when: round-trip test on a sample tree.

## Later (v1)

Comments and mentions, inbox, full-text search, Timeline and Calendar lenses, templates, import, AI summaries, Ask the workspace (RAG), AI database properties, Home "Today" digest.
