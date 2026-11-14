# Sharing and permissions

Pages have four access levels (FR-30), lowest first: **view**, **comment**, **edit**, **full**.

| Level | Can |
| --- | --- |
| view | Open the page, its subpages and databases; see who has access |
| comment | Same as view for now (comments come later) |
| edit | Change the title, content, database rows, properties and views; add subpages |
| full | Also move, trash and restore the page, and change who has access |

## Where a level comes from

A person's level on a page is the higher of:

- **Their own access**: the nearest grant for them on the page or a page above it. A grant further
  down overrides one higher up, so it can raise or lower what they inherit.
- **General access**: set on the nearest page (itself or above) that has it; top-level pages default
  to "Everyone in the workspace" with full access.
  - **Only people invited**: nobody else.
  - **Everyone in the workspace**: workspace members (not guests) get the chosen level.
  - **Anyone with the link**: as above, and anyone else who signs in with the link can view.
    Signed-out visitors can't open pages yet.

Workspace owners and admins always have full access. Someone who narrows general access keeps full
access (they get their own grant), and nobody can lower or remove their own full access.

A database's rows, views and schema follow the database page's access. Code: `api/app/permissions/`.

## Endpoints

| Method and path | What |
| --- | --- |
| `GET /api/pages/{id}/permissions` | Your level, whether you can share, general access and the people with access (and where inherited access comes from). Anyone who can open the page. |
| `POST /api/pages/{id}/share` | `{email, level}`: invite someone. People outside the workspace are added as guests; people without an account get one when they first sign in. They're emailed a link (logged in development). |
| `PUT` / `DELETE /api/pages/{id}/permissions/{user_id}` | Set or remove someone's own access on this page |
| `PUT /api/pages/{id}/general-access` | `{access: invited \| workspace \| public \| null, level}`; `null` inherits from the page above |

All but the first need full access. Pages report your level as `access`; people who can't open a page
get 404, people whose level is too low get 403.

## In the web app

The **Share** button at the top of each page opens the Share dialog: invite by email (workspace
members are suggested), change or remove people's access, set general access, copy the link.
People with view or comment access see the page read-only, with a note saying so.
