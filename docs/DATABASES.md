# Databases (API)

A database (T16, FR-11 to FR-13) is a page with a property schema. Its rows are pages too: children
of the database's page with `database_id` set and their values in `properties`. Rows don't appear in
the sidebar tree, ordinary pages can't be put inside a database, and rows can't leave it. Access to
a database is access to its page; a database in the trash can be read but not changed.

## Endpoints

| Method and path | What |
| --- | --- |
| `POST /api/databases` | Create `{workspace_id, parent_id?, title, properties?}`: a page plus a "Table" view |
| `GET /api/databases/{id}` · `GET /api/pages/{page_id}/database` | Schema and views |
| `PUT /api/databases/{id}/schema` | Replace the schema `{properties: [...]}` |
| `POST /api/databases/{id}/rows` | Add a row `{title, icon?, properties: {id: value}}` |
| `GET` / `PATCH /api/databases/{id}/rows/{row_id}` | Read or change a row (only what's sent; `null` clears) |
| `DELETE /api/pages/{row_id}` · `POST /api/pages/{row_id}/restore` | Trash or restore a row |
| `POST /api/databases/{id}/query` | `{view_id?, filter?, sorts?, page_size (1-100, 50), cursor?}` → `{results, next_cursor, has_more}` |
| `POST` / `PATCH` / `DELETE /api/databases/{id}/views[/{view_id}]` | Views: `{name, layout: table \| board, config}` |

## Properties

Ten types (FR-12): `title` (exactly one, id `title`, stored as the page title), `text`, `number`,
`select`, `multi_select`, `status` (options in groups `todo` / `in_progress` / `done`), `date`,
`person`, `checkbox`, `url`. Value forms are listed in `api/app/databases/properties.py`.

Changing a property's type, removing it, or removing an option clears the values that no longer fit,
and views drop the filters, sorts, grouping and columns that refer to them.

## Filters and sorts

```json
{
  "filter": {"and": [
    {"property": "state", "operator": "is_not", "value": "done"},
    {"or": [{"property": "due", "operator": "before", "value": "2026-12-01"},
            {"property": "tags", "operator": "contains", "value": "urgent"}]}
  ]},
  "sorts": [{"property": "priority", "direction": "ascending"}, {"property": "due", "direction": "descending"}]
}
```

| Types | Operators |
| --- | --- |
| title, text, url | `is`, `is_not`, `contains`, `does_not_contain`, `starts_with`, `ends_with`, `is_empty`, `is_not_empty` |
| number | `equals`, `not_equals`, `greater_than`, `less_than`, `greater_than_or_equal`, `less_than_or_equal`, `is_empty`, `is_not_empty` |
| select, status | `is`, `is_not`, `is_empty`, `is_not_empty` |
| multi_select, person | `contains`, `does_not_contain`, `is_empty`, `is_not_empty` |
| date (by start date) | `is`, `before`, `after`, `on_or_before`, `on_or_after`, `is_empty`, `is_not_empty` |
| checkbox | `is` |

Text matching is case-insensitive except `is` / `is_not`; "is not" and "does not contain" include
rows with no value. Groups nest up to 3 levels with up to 50 conditions. Select, multi-select and
status sort in option order. Empty values sort last in both directions; ties keep creation order.

Pagination uses cursors: pass `next_cursor` back as `cursor` with the same filter and sorts. A cursor
from another query is refused. Pages never skip or repeat rows, even with ties and empty values.
