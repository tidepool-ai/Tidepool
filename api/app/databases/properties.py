"""Property types (FR-12): the schema of a database and the values its rows hold.

A database's schema is a list of property definitions. Each row (a page) stores its values in
`pages.properties`, keyed by property id; the title lives in `pages.title`. How each type is stored:

| type         | value                                   | example                              |
| ------------ | --------------------------------------- | ------------------------------------ |
| title        | (the page title)                        |                                      |
| text         | string                                  | "Needs review"                       |
| number       | number                                  | 42.5                                 |
| select       | option id                               | "opt-high"                           |
| multi_select | list of option ids                      | ["opt-api", "opt-web"]               |
| status       | option id (options belong to a group)   | "opt-doing"                          |
| date         | {"start": "YYYY-MM-DD", "end": ... }    | {"start": "2026-11-05", "end": null} |
| person       | list of user ids (workspace members)    | ["6f1c…"]                            |
| checkbox     | true (unchecked is stored as no value)  | true                                 |
| url          | http(s) URL                             | "https://example.com"                |

Empty values (None, "", [], false) aren't stored, so "is empty" is just "has no value".
"""

import math
import re
import uuid
from datetime import date
from typing import Any, Literal

from pydantic import AnyHttpUrl, BaseModel, ConfigDict, Field, TypeAdapter, ValidationError

PropertyType = Literal[
    "title", "text", "number", "select", "multi_select", "status", "date", "person", "checkbox", "url"
]
Color = Literal["default", "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"]
StatusGroup = Literal["todo", "in_progress", "done"]

TITLE_ID = "title"
WITH_OPTIONS = frozenset({"select", "multi_select", "status"})
ID_PATTERN = r"^[A-Za-z0-9_-]{1,40}$"
MAX_TEXT = 2000
_url = TypeAdapter(AnyHttpUrl)


class SchemaError(ValueError):
    """The schema or a value doesn't fit; the message is shown to people."""


class Option(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str | None = Field(default=None, pattern=ID_PATTERN)
    name: str = Field(min_length=1, max_length=100)
    color: Color = "default"
    # Status options only: which column of the status they belong to.
    group: StatusGroup | None = None


class PropertyDef(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str | None = Field(default=None, pattern=ID_PATTERN)
    name: str = Field(min_length=1, max_length=100)
    type: PropertyType
    options: list[Option] | None = Field(default=None, max_length=200)
    number_format: Literal["number", "percent", "dollar", "euro"] | None = None


DEFAULT_STATUS_OPTIONS = [
    {"id": "not-started", "name": "Not started", "color": "gray", "group": "todo"},
    {"id": "in-progress", "name": "In progress", "color": "blue", "group": "in_progress"},
    {"id": "done", "name": "Done", "color": "green", "group": "done"},
]


def new_id() -> str:
    return uuid.uuid4().hex[:8]


def default_schema() -> list[dict[str, Any]]:
    return [{"id": TITLE_ID, "name": "Name", "type": "title"}]


def normalize_schema(
    definitions: list[PropertyDef], previous: list[dict[str, Any]] | None = None
) -> list[dict[str, Any]]:
    """Check a whole schema and fill in ids; returns what's stored."""
    known = {prop["id"]: prop for prop in previous or []}
    titles = [d for d in definitions if d.type == "title"]
    if len(titles) != 1:
        raise SchemaError("A database has exactly one title property")
    names: set[str] = set()
    ids: set[str] = set()
    result: list[dict[str, Any]] = []
    for definition in definitions:
        if definition.type == "title":
            prop_id = TITLE_ID
        elif definition.id is None or definition.id not in known:
            prop_id = definition.id if definition.id and definition.id != TITLE_ID else new_id()
        else:
            prop_id = definition.id
        if prop_id == TITLE_ID and definition.type != "title":
            raise SchemaError("The id 'title' is for the title property")
        name = definition.name.strip()
        if not name:
            raise SchemaError("Property names can't be blank")
        if name.casefold() in names:
            raise SchemaError(f"Two properties are called {name!r}")
        if prop_id in ids:
            raise SchemaError(f"Two properties have the id {prop_id!r}")
        names.add(name.casefold())
        ids.add(prop_id)
        prop: dict[str, Any] = {"id": prop_id, "name": name, "type": definition.type}
        if definition.type in WITH_OPTIONS:
            prop["options"] = _normalize_options(definition)
        elif definition.options:
            raise SchemaError(f"{name}: only select, multi-select and status properties have options")
        if definition.type == "number":
            prop["number_format"] = definition.number_format or "number"
        result.append(prop)
    return result


def _normalize_options(definition: PropertyDef) -> list[dict[str, Any]]:
    options = definition.options
    if options is None:
        return [dict(o) for o in DEFAULT_STATUS_OPTIONS] if definition.type == "status" else []
    seen_ids: set[str] = set()
    seen_names: set[str] = set()
    result = []
    for option in options:
        option_id = option.id or new_id()
        name = option.name.strip()
        if option_id in seen_ids or name.casefold() in seen_names:
            raise SchemaError(f"{definition.name}: option {name!r} is listed twice")
        seen_ids.add(option_id)
        seen_names.add(name.casefold())
        entry: dict[str, Any] = {"id": option_id, "name": name, "color": option.color}
        if definition.type == "status":
            entry["group"] = option.group or "todo"
        elif option.group is not None:
            raise SchemaError(f"{definition.name}: only status options have a group")
        result.append(entry)
    return result


def option_ids(prop: dict[str, Any]) -> list[str]:
    return [option["id"] for option in prop.get("options", [])]


def parse_date(value: Any, what: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise SchemaError(f"{what}: dates look like 2026-11-05")
    try:
        date.fromisoformat(value)
    except ValueError:
        raise SchemaError(f"{what}: {value} isn't a real date") from None
    return value


def normalize_value(prop: dict[str, Any], value: Any, members: set[str]) -> Any:
    """A row's value for `prop`, checked and in stored form; None means "no value"."""
    kind, name = prop["type"], prop["name"]
    if value is None:
        return None
    if kind == "text":
        if not isinstance(value, str):
            raise SchemaError(f"{name}: expected text")
        if len(value) > MAX_TEXT:
            raise SchemaError(f"{name}: text can be up to {MAX_TEXT} characters")
        return value or None
    if kind == "number":
        if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value):
            raise SchemaError(f"{name}: expected a number")
        return value
    if kind in ("select", "status"):
        if value == "":
            return None
        if value not in option_ids(prop):
            raise SchemaError(f"{name}: {value!r} isn't one of its options")
        return value
    if kind == "multi_select":
        if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
            raise SchemaError(f"{name}: expected a list of options")
        unknown = [v for v in value if v not in option_ids(prop)]
        if unknown:
            raise SchemaError(f"{name}: {unknown[0]!r} isn't one of its options")
        unique = list(dict.fromkeys(value))
        return unique or None
    if kind == "person":
        if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
            raise SchemaError(f"{name}: expected a list of people")
        unique = list(dict.fromkeys(value))
        if any(person not in members for person in unique):
            raise SchemaError(f"{name}: everyone picked must be in the workspace")
        return unique or None
    if kind == "date":
        if isinstance(value, str):
            value = {"start": value}
        if not isinstance(value, dict) or set(value) - {"start", "end"} or "start" not in value:
            raise SchemaError(f'{name}: expected {{"start": "YYYY-MM-DD", "end": null}}')
        start = parse_date(value["start"], name)
        end = value.get("end")
        if end is not None:
            end = parse_date(end, name)
            if end < start:
                raise SchemaError(f"{name}: the end date is before the start")
        return {"start": start, "end": end}
    if kind == "checkbox":
        if not isinstance(value, bool):
            raise SchemaError(f"{name}: expected true or false")
        return True if value else None
    if kind == "url":
        if not isinstance(value, str):
            raise SchemaError(f"{name}: expected a link")
        if not value:
            return None
        try:
            _url.validate_python(value)
        except ValidationError:
            raise SchemaError(f"{name}: links start with http:// or https://") from None
        if len(value) > 2048:
            raise SchemaError(f"{name}: links can be up to 2048 characters")
        return value
    raise SchemaError(f"{name}: the title is set as the row's title")


def apply_values(
    schema: list[dict[str, Any]], current: dict[str, Any], changes: dict[str, Any], members: set[str]
) -> dict[str, Any]:
    """`current` with `changes` applied (unknown properties are an error; None clears a value)."""
    by_id = {prop["id"]: prop for prop in schema}
    result = dict(current)
    for prop_id, raw in changes.items():
        prop = by_id.get(prop_id)
        if prop is None:
            raise SchemaError(f"No property with id {prop_id!r}")
        if prop["type"] == "title":
            raise SchemaError("Set the title as the row's title, not a property")
        value = normalize_value(prop, raw, members)
        if value is None:
            result.pop(prop_id, None)
        else:
            result[prop_id] = value
    return result
