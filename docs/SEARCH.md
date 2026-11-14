# Command bar and search

**Ctrl+K** (⌘K on a Mac), or **Search** in the sidebar, opens the command bar (FR-27).

- Empty: your recently opened pages, then the workspace's recently edited ones.
- As you type: pages whose title contains the text (titles that start with it first, then shorter
  titles, then the most recently edited), with their breadcrumb.
- Actions: **New page** (titled with what you typed) and **Create task**, which adds a row (titled
  with what you typed) to the database you're looking at, or else the one you opened last, and opens
  it in the side peek.
- Keyboard: type, ↑/↓ to choose (wraps), Enter to open, Tab / Shift+Tab to switch between All,
  Pages and Actions, Esc to close. Focus goes back where it was. From 900px wide, a preview pane
  shows the highlighted page.

## API

`GET /api/workspaces/{id}/search?q=&limit=20` (limit 1–50, `q` up to 200 characters; any workspace
member, guests included). Results only ever include pages the caller can open, and breadcrumbs
(`path`) only name pages they can open. With no `q`, it returns recent pages. Opening a page
(`GET /api/pages/{id}`) records the visit (`page_visits`, migration 0009, which also adds a trigram
index for title search).
