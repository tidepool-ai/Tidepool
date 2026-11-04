# Tidepool — Product Requirements Document

Nov 4, 2026 · RJ · Live version: https://claude.ai/artifact/QdR6dzR13VafYe2gg3SGVV

## Overview

We are building **Tidepool**, a block-based workspace that replicates Notion's core: nested pages built from blocks, databases with multiple views, and real-time collaboration. The frontend is Angular; the backend is Python (FastAPI).

**Problem.** Teams spread notes, docs, wikis and task tracking across many tools. Notion solved this with one flexible primitive (the block), but it is closed-source and cannot be self-hosted on a private network. A self-hostable clone gives full data control.

**Goals**

- Ship an MVP where a user can create nested pages, edit with 15+ block types, and build a database with Table and Board views.
- Real-time co-editing for up to 20 simultaneous editors per page, with presence cursors.
- Self-hostable with one Docker Compose file or a Helm chart.
- Feel native: under 100 ms for typing, slash menu, and page switch on cached pages.

* Built-in AI (write, rewrite, summarize, ask the workspace, autofill database properties) powered by our hosted GLM model through its OpenAI-compatible API.

**Non-goals (v1)**

- Notion Sites/public publishing, Calendar and Mail apps.
- Native mobile apps (responsive web only).
- Full API compatibility with Notion's public API.
- Formula language parity beyond the basic function set listed in section 4.

## Target users

The MVP targets small teams (5 to 50 people) who want one self-hosted place for docs and lightweight project tracking.

| Persona | Who they are | Core job | Must-have features |
| --- | --- | --- | --- |
| Solo note-taker | Developer or student organizing personal knowledge | Capture and link notes fast | Pages, nesting, slash menu, search, Markdown shortcuts |
| Team lead | Runs a 5 to 15 person squad | Plan sprints, track tasks, write specs | Databases, Board view, assignees, comments, mentions |
| Knowledge owner | Maintains the team wiki | Keep docs organized and findable | Sidebar tree, templates, permissions, backlinks |
| Workspace admin | IT or platform engineer | Deploy, secure, manage members | SSO, roles, audit log, backup/export |

## Feature scope by release

The MVP proves the editor and databases; v1 adds collaboration depth; v2 adds power-user and enterprise features.

| Feature area | MVP (P0) | v1 (P1) | v2 (P2) |
| --- | --- | --- | --- |
| Pages & editor | Nested pages, 15 block types, slash menu, drag-to-reorder, Markdown shortcuts, icons & covers | Synced blocks, columns layout, toggle headings, page history (30 days) | Page locking, full-width/small-text options, PDF embed viewer |
| Databases | Inline + full-page DBs, Table & Board views, 10 property types, filter/sort | List, Gallery, Calendar views; Relation & Rollup; grouping | Timeline view, formulas v2, DB automations (if X then Y) |
| Collaboration | Real-time co-editing, presence avatars | Comments, @mentions, notifications inbox, live cursors | Suggested edits (track changes), guests |
| Organization | Sidebar tree, favorites, trash with restore | Backlinks, breadcrumbs, quick switcher (Cmd+K), templates gallery | Teamspaces, archived pages |
| Search | Title search | Full-text search with filters | Semantic search over workspace |
| Sharing & access | Workspace members, page-level share (Full / Edit / Comment / View) | Public link (read-only web), invite by email | SSO (OIDC/SAML), SCIM, audit log |
| Import/Export | Markdown export | Markdown & CSV import, HTML/PDF export | Notion export (.zip) importer |
| Platform | Light/dark theme, responsive web | Offline read cache, PWA install | Public REST API + webhooks |

## Functional requirements

Everything is a block: a page is a block whose children are blocks, and a database row is a page. Requirements below use FR-IDs for traceability.

### 4.1 Pages and block editor

- **FR-1** Create a page from the sidebar "+", the slash menu (`/page`), or by typing `[[` to link a new page.
- **FR-2** Pages nest without limit; each has an emoji/image icon, optional cover image, and title.
- **FR-3** Supported MVP blocks: Text, H1, H2, H3, Bulleted list, Numbered list, To-do, Toggle, Quote, Callout, Divider, Code (with language + syntax highlighting), Image, Bookmark/Link preview, Page link, Database (inline).
- **FR-4** Slash menu opens on `/`, filters as the user types, keyboard navigable, shows the block's icon and short description.
- **FR-5** Markdown shortcuts: `#`, `##`, `###`, `-`, `1.`, `[]`, `>`, ```` ``` ````, `---`, `**bold**`, `*italic*`, `` `code` ``.
- **FR-6** Each block has a hover handle (⋮⋮) for drag-to-reorder and a block menu: Turn into, Duplicate, Delete, Copy link, Color, Move to.
- **FR-7** Inline formatting toolbar on text selection: bold, italic, underline, strikethrough, code, link, text color/background, @mention, comment.
- **FR-8** Multi-block selection (Shift+click, drag box) supports bulk delete, move, turn into.
- **FR-9** Undo/redo across the whole page (Cmd+Z / Cmd+Shift+Z), collaboration-aware (undoes only your own changes).
- **FR-10** Paste rich content (HTML, Markdown) and images; images upload to object storage.

### 4.2 Databases

- **FR-11** A database is a collection of pages with a typed property schema. It can be inline in a page or a full page.
- **FR-12** MVP property types: Title, Text, Number, Select, Multi-select, Status, Date, Person, Checkbox, URL. v1 adds Relation, Rollup, Formula, Created/Edited time & by, Files.
- **FR-13** Views: each database has one or more named views. Each view stores its own layout, filters, sorts, grouping, and visible properties.
- **FR-14** Table view: resizable columns, add row/column, inline cell editing, column menu (sort, filter, hide, rename, change type).
- **FR-15** Board view: grouped by a Select or Status property, drag cards between columns updates the property, add card per column.
- **FR-16** Filters: AND/OR groups, operators per type (is, is not, contains, before/after, is empty). Sorts: multi-level.
- **FR-17** Opening a row shows it as a side peek (default), centered modal, or full page, with properties on top and page body below.

### 4.3 Workspace and navigation

- **FR-18** Left sidebar: workspace switcher, Search, Inbox, Settings, Favorites, Private and Shared page trees, Templates, Trash. Collapsible and resizable.
- **FR-19** Page tree supports expand/collapse, drag to re-parent, and right-click menu (rename, duplicate, move, delete, copy link).
- **FR-20** Breadcrumbs in the top bar; top bar also holds Share, Comments, Updates (history), Favorite, and the ⋯ page menu.
- **FR-21** Trash keeps deleted pages 30 days; restore or delete permanently.

### 4.4 Collaboration

- **FR-22** Multiple users edit the same page simultaneously; changes appear for others within 300 ms on a normal connection; no conflicting edits are lost.
- **FR-23** Presence: avatars of current viewers in the top bar; colored caret and selection per remote user (v1).
- **FR-24** Comments on a text range or a whole block; threaded replies; resolve/reopen.
- **FR-25** @mention a person (notifies them), a page (links it), or a date (renders a date chip with optional reminder).
- **FR-26** Inbox lists mentions, replies, and page invites; unread badge in the sidebar.

### 4.5 Search

- **FR-27** Cmd+K / Cmd+P opens quick search: recent pages when empty, results as you type with title and breadcrumb.
- **FR-28** Full-text search (v1) across titles and block content, filtered by creator, date edited, and teamspace; respects permissions.

### 4.6 Sharing and permissions

- **FR-29** Roles: Workspace Owner, Admin, Member, Guest.
- **FR-30** Page access levels: Full access, Can edit, Can comment, Can view. Permissions inherit to sub-pages unless overridden.
- **FR-31** Share dialog: invite by email or member name, set level, copy link, toggle "Publish to web" (v1).

### 4.7 Templates, import and export

- **FR-32** Template gallery with starter pages (Meeting notes, Project tracker, Docs wiki, Reading list, Sprint board).
- **FR-33** Database templates: a row template pre-fills properties and body.
- **FR-34** Export a page (and sub-pages) as Markdown + assets .zip (MVP); HTML and PDF (v1). Import Markdown and CSV (v1).

### 4.8 Appearance and color schemes

- **FR-35** Settings › Appearance offers Mode (Light, Dark, System), Color scheme (Tidepool, Graphite, Orchard, Dusk, Paper), Text size (Small, Default, Large) and a High contrast switch.
- **FR-36** Changes apply instantly with a live preview, no Save button; System mode follows the OS and updates live when it changes.
- **FR-37** The choice syncs to every device for the user (`GET/PATCH /api/me/preferences/appearance`); admins can set a workspace default that members can override.
- **FR-38** Every scheme meets WCAG AA contrast in light and dark; a CI test blocks any scheme that drops below 4.5:1 for text.

## AI features (GLM)

AI runs on our hosted GLM model through its OpenAI-compatible endpoint, so the backend uses the standard `openai` Python SDK with a custom `base_url` and API key. Swapping or upgrading the model is a config change, not a code change.

### 5.1 Features

| ID | Feature | What it does | Release |
| --- | --- | --- | --- |
| AI-1 | Ask AI in the editor | Space on an empty line or `/ai` opens a prompt bar: write, continue, brainstorm. Output streams into a draft block with Accept, Retry, Discard. | MVP |
| AI-2 | Rewrite selection | From the formatting toolbar: improve writing, fix grammar, shorter, longer, change tone, translate, explain. | MVP |
| AI-3 | Summarize page | Inserts a TL;DR callout at the top; extracts action items as to-dos with @mentions. | v1 |
| AI-4 | Ask the workspace | Chat panel that answers questions from the user's permitted pages, with clickable page citations (RAG). | v1 |
| AI-5 | AI database property | New property type with a prompt ("Summarize this row in one line", "Classify priority", "Extract tags"); fills on create, on edit, or in bulk. | v1 |
| AI-6 | Meeting notes from transcript | Paste a transcript into the Meeting Notes template; get summary, decisions, action items. | v1 |
| AI-7 | Natural language to database | "Create a bug tracker with severity, owner, status" builds the schema and views; "my overdue tasks" becomes a filter. | v2 |
| AI-8 | Semantic search | Meaning-based results in Cmd+K alongside keyword results. | v2 |
| AI-9 | Inline autocomplete | Ghost-text suggestion while typing, Tab to accept; opt-in per user. | v2 |
| AI-10 | AI agent actions | Model calls tools (create page, query database, update property) via function calling; every write needs user confirmation. | v2 |

### 5.2 How it works

- **AI module in FastAPI** (`app/ai/`): one prompt template per action, a shared client built from `GLM_BASE_URL`, `GLM_API_KEY`, `GLM_MODEL` env vars. The key never reaches the browser.
- **Streaming**: responses stream to Angular over Server-Sent Events; the editor writes chunks into a local draft block that only becomes part of the Yjs doc on Accept.
- **Context**: the current page (or selection) is converted to Markdown and trimmed to the model's context window, with headings kept so structure survives truncation.
- **Retrieval for AI-4**: a worker chunks pages (\~500 tokens) and stores embeddings in Postgres with pgvector. Retrieval filters by the asking user's effective permissions before anything is sent to the model.
- **Admin controls**: workspace toggle for AI, per-user daily token quota, rate limits, and a usage log (tokens per feature, per user).

### 5.3 Endpoints

- `POST /api/ai/complete` (SSE) — `{action, page_id, selection, prompt}` for AI-1, AI-2, AI-3
- `POST /api/ai/ask` (SSE) — workspace Q&A with citations
- `POST /api/databases/{id}/ai-fill` — queue an autofill job; progress over the page WebSocket
- `GET /api/ai/usage` — quota and usage for the current user or workspace

### 5.4 Targets and risks

| Item | Target or mitigation |
| --- | --- |
| First token latency | < 1.5 s p95 |
| Accept rate of AI drafts | ≥ 40% of AI-1/AI-2 drafts accepted |
| Made-up answers in Q&A | Every answer cites pages; with no matching source it says so instead of guessing |
| Prompt injection from page text | Page content is passed as data, never as instructions; writes always need confirmation |
| Cost of bulk autofill | Per-workspace token budget; jobs show progress and can be cancelled |
| Endpoint outage | Timeouts and retries; AI buttons disable gracefully, the editor keeps working |

**Open questions**

- [ ] Does the GLM host expose an embeddings endpoint? If not, run an open-source embedding model (e.g. bge-small) in the worker.
- [ ] Does the GLM model support function calling (needed for AI-7 and AI-10)?
- [ ] Context window and rate limits of the hosted deployment.

## Non-functional requirements

| Area | Requirement | Target |
| --- | --- | --- |
| Performance | Keystroke-to-render latency | < 16 ms (60 fps) on a 1,000-block page |
| Performance | Page open (cached / cold) | < 150 ms / < 800 ms p95 |
| Performance | Database Table view | 10,000 rows scroll smoothly (virtual scrolling) |
| Performance | Initial JS bundle | < 250 KB gzipped; editor & DB views lazy-loaded |
| Realtime | Remote change propagation | < 300 ms p95 within region |
| Scale | Concurrent editors per page | 20 (MVP), 100 (v2) |
| Availability | API uptime | 99.9% monthly |
| Offline | Read cached pages; queue edits while offline (v1) | Sync on reconnect with no data loss |
| Security | Auth | OAuth2/OIDC + email magic link; JWT access (15 min) + rotating refresh |
| Security | Data | TLS everywhere, AES-256 at rest, per-page permission check on every API and WebSocket message |
| Security | Abuse | Rate limits per user/IP; file type & size checks (25 MB MVP) |
| Accessibility | Standard | WCAG 2.2 AA; full keyboard use of editor, slash menu, sidebar, DB views |
| i18n | Text | All strings externalized (Angular i18n); RTL-ready layout |
| Observability | Telemetry | OpenTelemetry traces, Prometheus metrics, structured JSON logs |
| Backup | Data recovery | Daily DB snapshot, point-in-time restore 7 days |

## Technical architecture

The Angular app calls FastAPI over REST for everything except live page content, which syncs over a WebSocket as Yjs CRDT updates so concurrent edits merge without conflicts.

Architecture: Angular client → gateway (HTTPS + WSS) → FastAPI REST API, Realtime service (WebSocket + pycrdt), Background workers → PostgreSQL, Redis, S3/MinIO, Meilisearch.

The realtime service is the critical path: it checks permission on every message, merges updates, and fans them out across workers via Redis.

**Stack**

| Layer | Choice | Why |
| --- | --- | --- |
| Frontend framework | Angular 22, standalone components, signals, NgRx SignalStore, zoneless change detection | Fine-grained reactivity keeps typing fast |
| Editor | Tiptap (ProseMirror) wrapped in Angular components; custom node views for each block | Battle-tested selection, IME, paste handling |
| Collaboration (client) | Yjs + y-prosemirror + y-indexeddb | CRDT merge, offline cache, undo per user |
| UI utilities | Angular CDK (drag-drop, overlay, virtual scroll, a11y), SCSS design tokens | Accessible primitives, no heavy UI kit |
| API | Python 3.12, FastAPI, Pydantic v2, SQLAlchemy 2 (async), Alembic | Typed, async, auto OpenAPI for client codegen |
| Realtime | FastAPI WebSockets + pycrdt (Yjs-compatible), Redis pub/sub | Python-native Yjs protocol, horizontal scale |
| Jobs | Celery (or Arq) on Redis | Search indexing, export, import, notifications |
| Database | PostgreSQL 16 (JSONB, ltree for page paths) | Flexible properties plus fast tree queries |
| Search | Postgres FTS (MVP), Meilisearch (v1) | Start simple, upgrade for typo-tolerance |
| Files | S3 / MinIO, presigned uploads | Uploads bypass the API servers |
| Deploy | Docker Compose; Helm chart for Kubernetes | One-command self-hosting |

**Core data model**

| Table | Key columns |
| --- | --- |
| workspaces | id, name, owner\_id |
| members | workspace\_id, user\_id, role |
| pages | id, workspace\_id, parent\_id, path (ltree), title, icon, cover, database\_id (when a row), properties JSONB, archived\_at |
| page\_docs | page\_id, ydoc\_state (bytea), version, updated\_at |
| blocks | id, page\_id, parent\_block\_id, type, content JSONB, position (fractional index); derived from page\_docs for search and export |
| databases | id, page\_id, schema JSONB (property definitions) |
| db\_views | id, database\_id, name, layout, config JSONB (filters, sorts, group\_by, visible properties) |
| permissions | page\_id, principal (user, group or public), level |
| comments | id, page\_id, block\_id, anchor, thread\_id, body, resolved\_at |
| notifications | id, user\_id, type, payload JSONB, read\_at |

**Key endpoints**

- `POST /api/pages` · `GET/PATCH/DELETE /api/pages/{id}` — create, read, rename/move, trash
- `GET /api/pages/{id}/children` — sidebar tree, loaded one level at a time
- `POST /api/databases/{id}/query` — filters, sorts, cursor pagination
- `PUT /api/databases/{id}/schema` · `POST /api/databases/{id}/views`
- `GET /api/search?q=` · `POST /api/files/presign`
- `POST /api/pages/{id}/share` · `GET /api/pages/{id}/permissions`
- `WS /ws/pages/{id}` — Yjs sync (step 1/2, updates) plus awareness for presence

**Sync flow**

1. Client opens the page socket; the server sends the stored Yjs state.
2. Local edits apply instantly to the client's Yjs doc and go out as binary updates.
3. The server checks permission, merges into the room's doc, and broadcasts through Redis to other workers.
4. State persists every 2 seconds (debounced) and compacts into a snapshot every 500 updates.
5. A worker re-derives the blocks table for search, backlinks and export.

**AI path.** The FastAPI `ai` module calls the GLM endpoint with the OpenAI Python SDK (custom `base_url`), streams tokens to the browser over SSE, and a worker maintains pgvector embeddings for workspace Q&A (see AI features).

## UX and design system

The UI stays out of the way: content is the hero, chrome appears on hover. Screen designs are in the companion Design canvas.

**Design principles**

- Quiet chrome: handles, "+" buttons and menus appear only on hover or focus.
- Keyboard first: every action reachable via slash menu, shortcuts, or Cmd+K.
- One primitive: blocks look and behave the same in pages, DB row pages, and templates.

**Tokens**

| Token | Tidepool light | Tidepool dark |
| --- | --- | --- |
| Background | #F3F6F5 | #0B1A19 |
| Surface | #FFFFFF | #122523 |
| Text / muted | #10302D / #4B5F5C | #E3EEEC / #9DB5B1 |
| Border | #DCE5E3 | #24403C |
| Primary (actions, focus) | #0F766E | #2DD4BF |
| Accent (create actions) | #C2410C | #FB923C |
| AI | #4F46E5 | #A5B4FC |
| Icon rail | #0F2E2B | #071312 |
| Fonts | Newsreader for page titles; Plus Jakarta Sans for UI and body; JetBrains Mono for code | same |
| Shape | Flat, bordered surfaces; radius 6 / 10 / 14 / 18; 44px touch targets | same |

The other four schemes and the full token list, theming code (Angular ThemeService, FastAPI endpoints) and component specs are in DESIGN-SYSTEM.md.

**Screen inventory**

1. Login / sign-up (email magic link + Google/OIDC)
2. Home: Today view with AI digest, my tasks and recent pages
3. Page editor with slash menu open
4. Database: Table view
5. Database: Board view
6. Row side peek (properties + body)
7. Quick search (Cmd+K)
8. Share dialog
9. Comments panel and Inbox
10. Settings, including Appearance with the color scheme changer

## Metrics, milestones and risks

Success means a 10-person team runs its docs and sprint board here for four straight weeks without falling back to another tool.

**Success metrics**

| Metric | Target at v1 |
| --- | --- |
| Weekly active editors / total members | ≥ 60% |
| Pages created per active user per week | ≥ 5 |
| Databases with ≥ 2 views | ≥ 30% of databases |
| Real-time sync errors (lost edit reports) | 0 per 10,000 sessions |
| p95 page open time | < 800 ms |
| Crash-free sessions | ≥ 99.5% |

**Milestones** (assuming 2 frontend + 2 backend engineers)

1. Weeks 1 to 3 — Foundations: auth, workspace/page models, Angular shell, sidebar tree, design tokens.
2. Weeks 4 to 8 — Editor: block model, 15 block types, slash menu, drag-and-drop, Markdown shortcuts.
3. Weeks 9 to 11 — Realtime: Yjs integration, WebSocket service, presence, offline queue groundwork.
4. Weeks 12 to 15 — Databases: schema, Table and Board views, filters/sorts, row side peek.
5. Weeks 16 to 19 — Sharing, permissions, trash, Markdown export, Ask AI and Rewrite (GLM), hardening. **MVP release.**
6. Weeks 20 to 30 — v1: comments, mentions, inbox, full-text search, more views, templates, import, AI summaries, Ask the workspace, AI database property.

**Risks**

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Editor complexity (selection, IME, paste) | High | Build on ProseMirror/Tiptap instead of a custom contenteditable |
| CRDT document growth over time | Medium | Periodic snapshot + garbage-collect Yjs updates; store compacted state |
| Permission checks slow on deep trees | Medium | Materialized ancestor path + cached effective permissions per page |
| Python WebSocket fan-out at scale | Medium | Redis pub/sub between workers; shard rooms by page id |
| Large DB views (10k+ rows) | Medium | Server-side filter/sort, cursor pagination, CDK virtual scroll |

**Open questions**

- [ ] Self-host only, or also a hosted SaaS offering?
- [ ] Do we need Notion-export import in v1 to drive migration?
- [ ] Product name: decided, Tidepool (repo tidepool-ai/tidepool).
