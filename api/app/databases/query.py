"""Filters, sorts and cursor pagination for database queries (FR-16), compiled to SQL on JSONB.

Filter:  {"and": [<filter>, ...]} | {"or": [<filter>, ...]} | {"property": id, "operator": op, "value": v}
Sorts:   [{"property": id, "direction": "ascending" | "descending"}, ...]   (first one wins)

Empty values sort last in both directions. Rows with equal sort values keep creation order, which
also makes every position in the result unique, so a cursor can say exactly where a page ended.
"""

import base64
import binascii
import hashlib
import json
import uuid
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy import (
    ARRAY,
    Boolean,
    ColumnElement,
    DateTime,
    Integer,
    Numeric,
    Text,
    and_,
    case,
    false,
    func,
    literal,
    not_,
    or_,
    true,
)
from sqlalchemy.sql.type_api import TypeEngine

from app.databases.properties import SchemaError, option_ids, parse_date
from app.pages.models import Page

MAX_DEPTH = 3
MAX_CONDITIONS = 50
MAX_SORTS = 5

TEXTUAL = (
    "is",
    "is_not",
    "contains",
    "does_not_contain",
    "starts_with",
    "ends_with",
    "is_empty",
    "is_not_empty",
)
NUMERIC = (
    "equals",
    "not_equals",
    "greater_than",
    "less_than",
    "greater_than_or_equal",
    "less_than_or_equal",
    "is_empty",
    "is_not_empty",
)
CHOICE = ("is", "is_not", "is_empty", "is_not_empty")
LISTS = ("contains", "does_not_contain", "is_empty", "is_not_empty")
DATES = ("is", "before", "after", "on_or_before", "on_or_after", "is_empty", "is_not_empty")

OPERATORS: dict[str, tuple[str, ...]] = {
    "title": TEXTUAL,
    "text": TEXTUAL,
    "url": TEXTUAL,
    "number": NUMERIC,
    "select": CHOICE,
    "status": CHOICE,
    "multi_select": LISTS,
    "person": LISTS,
    "date": DATES,
    "checkbox": ("is",),
}
NO_VALUE = ("is_empty", "is_not_empty")


class QueryError(ValueError):
    """A filter, sort or cursor that doesn't fit the database; the message is shown to people."""


# Values as SQL expressions -------------------------------------------------------------------


def _json(prop_id: str) -> ColumnElement[Any]:
    return Page.properties[prop_id]


def _text(prop: dict[str, Any]) -> ColumnElement[str]:
    return Page.title if prop["type"] == "title" else _json(prop["id"]).astext


def _number(prop: dict[str, Any]) -> ColumnElement[Decimal]:
    value = _json(prop["id"])
    return case((func.jsonb_typeof(value) == "number", value.astext.cast(Numeric)), else_=None)


def _date(prop: dict[str, Any]) -> ColumnElement[str]:
    return _json(prop["id"])["start"].astext


def _checked(prop: dict[str, Any]) -> ColumnElement[bool]:
    return func.coalesce(_json(prop["id"]).astext.cast(Boolean), false())


def _like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


# Filters -----------------------------------------------------------------------------------------


def compile_filter(raw: Any, schema: list[dict[str, Any]]) -> ColumnElement[bool]:
    """Check a filter against the schema and turn it into a WHERE clause."""
    if raw is None:
        return true()
    counter = [0]
    return _compile(raw, {p["id"]: p for p in schema}, 1, counter)


def _compile(
    raw: Any, props: dict[str, dict[str, Any]], depth: int, counter: list[int]
) -> ColumnElement[bool]:
    if not isinstance(raw, dict):
        raise QueryError("A filter is an object")
    if "and" in raw or "or" in raw:
        if len(raw) != 1:
            raise QueryError('A group has just "and" or "or"')
        if depth > MAX_DEPTH:
            raise QueryError(f"Filters can be nested {MAX_DEPTH} levels deep")
        kind = "and" if "and" in raw else "or"
        items = raw[kind]
        if not isinstance(items, list):
            raise QueryError(f'"{kind}" takes a list of filters')
        parts = [_compile(item, props, depth + 1, counter) for item in items]
        if not parts:
            return true()
        return and_(*parts) if kind == "and" else or_(*parts)
    counter[0] += 1
    if counter[0] > MAX_CONDITIONS:
        raise QueryError(f"A filter can have up to {MAX_CONDITIONS} conditions")
    unknown = set(raw) - {"property", "operator", "value"}
    if unknown or "property" not in raw or "operator" not in raw:
        raise QueryError('A condition is {"property": …, "operator": …, "value": …}')
    prop = props.get(raw["property"])
    if prop is None:
        raise QueryError(f"No property with id {raw['property']!r}")
    operator = raw["operator"]
    allowed = OPERATORS[prop["type"]]
    if operator not in allowed:
        raise QueryError(f"{prop['name']} ({prop['type']}) can be filtered with: {', '.join(allowed)}")
    value = raw.get("value")
    if operator in NO_VALUE:
        if value is not None:
            raise QueryError(f'"{operator}" takes no value')
    else:
        value = _check_value(prop, operator, value)
    return _condition(prop, operator, value)


def _check_value(prop: dict[str, Any], operator: str, value: Any) -> Any:
    kind, name = prop["type"], prop["name"]
    if kind in ("title", "text", "url"):
        if not isinstance(value, str):
            raise QueryError(f"{name}: filter by text")
        return value
    if kind == "number":
        if isinstance(value, bool) or not isinstance(value, int | float):
            raise QueryError(f"{name}: filter by a number")
        return Decimal(str(value))
    if kind in ("select", "status", "multi_select"):
        if value not in option_ids(prop):
            raise QueryError(f"{name}: {value!r} isn't one of its options")
        return value
    if kind == "person":
        try:
            return str(uuid.UUID(str(value)))
        except ValueError:
            raise QueryError(f"{name}: filter by a person's id") from None
    if kind == "date":
        try:
            return parse_date(value, name)
        except SchemaError as exc:
            raise QueryError(str(exc)) from None
    if not isinstance(value, bool):  # checkbox
        raise QueryError(f"{name}: filter by true or false")
    return value


def _condition(prop: dict[str, Any], operator: str, value: Any) -> ColumnElement[bool]:
    kind = prop["type"]
    if kind in ("title", "text", "url"):
        column = _text(prop)
        empty = or_(column.is_(None), column == "")
        match operator:
            case "is":
                return column == value
            case "is_not":
                return column.is_distinct_from(value)
            case "contains":
                return column.ilike(f"%{_like(value)}%", escape="\\")
            case "does_not_contain":
                return or_(column.is_(None), not_(column.ilike(f"%{_like(value)}%", escape="\\")))
            case "starts_with":
                return column.ilike(f"{_like(value)}%", escape="\\")
            case "ends_with":
                return column.ilike(f"%{_like(value)}", escape="\\")
            case "is_empty":
                return empty
            case _:
                return not_(empty)
    if kind == "number":
        number = _number(prop)
        match operator:
            case "equals":
                return number == value
            case "not_equals":
                return number.is_distinct_from(value)
            case "greater_than":
                return number > value
            case "less_than":
                return number < value
            case "greater_than_or_equal":
                return number >= value
            case "less_than_or_equal":
                return number <= value
            case "is_empty":
                return number.is_(None)
            case _:
                return number.is_not(None)
    if kind in ("select", "status"):
        column = _json(prop["id"]).astext
        match operator:
            case "is":
                return column == value
            case "is_not":
                return column.is_distinct_from(value)
            case "is_empty":
                return column.is_(None)
            case _:
                return column.is_not(None)
    if kind in ("multi_select", "person"):
        values = _json(prop["id"])
        has = values.contains([value])
        match operator:
            case "contains":
                return func.coalesce(has, false())
            case "does_not_contain":
                return not_(func.coalesce(has, false()))
            case "is_empty":
                return values.is_(None)
            case _:
                return values.is_not(None)
    if kind == "date":
        start = _date(prop)
        match operator:
            case "is":
                return start == value
            case "before":
                return start < value
            case "after":
                return start > value
            case "on_or_before":
                return start <= value
            case "on_or_after":
                return start >= value
            case "is_empty":
                return start.is_(None)
            case _:
                return start.is_not(None)
    return _checked(prop) == value  # checkbox "is"


# Sorts and cursors -------------------------------------------------------------------------------


@dataclass(frozen=True)
class SortKey:
    expression: ColumnElement[Any]
    descending: bool
    type: TypeEngine[Any]
    nullable: bool = True


def sort_keys(raw: Any, schema: list[dict[str, Any]]) -> list[SortKey]:
    """The ORDER BY keys for `raw` sorts, ending with creation time and id (always unique)."""
    if raw is None:
        raw = []
    if not isinstance(raw, list) or len(raw) > MAX_SORTS:
        raise QueryError(f"Sorts are a list of up to {MAX_SORTS}")
    props = {p["id"]: p for p in schema}
    keys: list[SortKey] = []
    for item in raw:
        if not isinstance(item, dict) or set(item) - {"property", "direction"} or "property" not in item:
            raise QueryError('A sort is {"property": …, "direction": "ascending" | "descending"}')
        prop = props.get(item["property"])
        if prop is None:
            raise QueryError(f"No property with id {item['property']!r}")
        direction = item.get("direction", "ascending")
        if direction not in ("ascending", "descending"):
            raise QueryError('A sort direction is "ascending" or "descending"')
        keys.append(_sort_key(prop, direction == "descending"))
    keys.append(SortKey(Page.created_at, False, DateTime(timezone=True), nullable=False))
    keys.append(SortKey(Page.id.cast(Text), False, Text(), nullable=False))
    return keys


def _sort_key(prop: dict[str, Any], descending: bool) -> SortKey:
    kind = prop["type"]
    if kind == "title":
        return SortKey(func.lower(Page.title), descending, Text(), nullable=False)
    if kind in ("text", "url"):
        return SortKey(func.lower(_text(prop)), descending, Text())
    if kind == "number":
        return SortKey(_number(prop), descending, Numeric())
    if kind in ("select", "status", "multi_select"):
        # In the order the options are listed in the schema.
        first = _json(prop["id"]).astext if kind != "multi_select" else _json(prop["id"])[0].astext
        order = literal(option_ids(prop) or [""], ARRAY(Text))
        return SortKey(func.array_position(order, first), descending, Integer())
    if kind == "person":
        return SortKey(_json(prop["id"])[0].astext, descending, Text())
    if kind == "date":
        return SortKey(_date(prop), descending, Text())
    return SortKey(_checked(prop), descending, Boolean(), nullable=False)


def order_by(keys: list[SortKey]) -> list[Any]:
    return [(k.expression.desc() if k.descending else k.expression.asc()).nulls_last() for k in keys]


def after(keys: list[SortKey], values: list[Any]) -> ColumnElement[bool]:
    """WHERE clause for "rows after the row with these key values" in `order_by(keys)` order."""
    clauses = []
    for i, key in enumerate(keys):
        value = values[i]
        if value is None:
            continue  # empty sorts last: nothing comes after it on this key
        bound = literal(value, key.type)
        beyond = key.expression < bound if key.descending else key.expression > bound
        if key.nullable:
            beyond = or_(beyond, key.expression.is_(None))
        same = [
            keys[j].expression.is_(None)
            if values[j] is None
            else keys[j].expression == literal(values[j], keys[j].type)
            for j in range(i)
        ]
        clauses.append(and_(*same, beyond))
    return or_(*clauses) if clauses else false()


def fingerprint(database_id: uuid.UUID, filter_: Any, sorts: Any) -> str:
    raw = json.dumps([str(database_id), filter_, sorts], sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def encode_cursor(values: list[Any], query_id: str) -> str:
    def plain(value: Any) -> Any:
        if isinstance(value, Decimal):
            return {"d": str(value)}
        if isinstance(value, datetime):
            return {"t": value.isoformat()}
        return value

    payload = json.dumps({"q": query_id, "v": [plain(v) for v in values]}, separators=(",", ":"))
    return base64.urlsafe_b64encode(payload.encode()).decode().rstrip("=")


def decode_cursor(cursor: str, query_id: str, keys: list[SortKey]) -> list[Any]:
    try:
        payload = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
        if payload["q"] != query_id:
            raise QueryError("This cursor belongs to a different query; start again without it")
        values = payload["v"]
        if not isinstance(values, list) or len(values) != len(keys):
            raise ValueError
        result = []
        for value in values:
            if isinstance(value, dict) and "d" in value:
                result.append(Decimal(value["d"]))
            elif isinstance(value, dict) and "t" in value:
                result.append(datetime.fromisoformat(value["t"]))
            else:
                result.append(value)
        return result
    except QueryError:
        raise
    except (ValueError, KeyError, TypeError, binascii.Error, InvalidOperation, json.JSONDecodeError):
        raise QueryError("That cursor isn't valid") from None
