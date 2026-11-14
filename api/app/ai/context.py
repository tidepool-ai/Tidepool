"""A page's content as Markdown for the model, trimmed to a budget with its headings kept (PRD 5.2)."""

import re
from dataclasses import dataclass, field
from typing import Any

from pycrdt import Doc, XmlElement, XmlFragment, XmlText

FIELD = "default"  # the Yjs fragment the editor writes to (web: COLLAB_FIELD)
GAP = "…"


@dataclass
class Node:
    """A block or inline node, from the live (Yjs) document or saved Tiptap JSON."""

    type: str
    attrs: dict[str, Any] = field(default_factory=dict)
    children: list["Node"] = field(default_factory=list)
    text: str = ""


def from_yjs(state: bytes) -> list[Node]:
    doc = Doc()
    doc.apply_update(state)
    fragment = doc.get(FIELD, type=XmlFragment)

    def convert(item: XmlElement | XmlText) -> Node:
        if isinstance(item, XmlText):
            return Node("text", text=str(item))
        return Node(item.tag or "", dict(item.attributes), [convert(child) for child in item.children])

    return [convert(child) for child in fragment.children]


def from_json(doc: dict[str, Any] | None) -> list[Node]:
    def convert(item: dict[str, Any]) -> Node:
        if item.get("type") == "text":
            return Node("text", text=str(item.get("text", "")))
        return Node(
            str(item.get("type", "")),
            dict(item.get("attrs") or {}),
            [convert(child) for child in item.get("content") or [] if isinstance(child, dict)],
        )

    return [convert(child) for child in (doc or {}).get("content") or [] if isinstance(child, dict)]


def _inline(node: Node) -> str:
    if node.type == "text":
        return node.text
    if node.type == "hardBreak":
        return "\n"
    return "".join(_inline(child) for child in node.children)


def _blocks(nodes: list[Node], prefix: str = "") -> list[str]:
    """Markdown blocks (one string each) for a list of block nodes."""
    out: list[str] = []
    for node in nodes:
        out += [prefix + line if prefix else line for line in _block(node)]
    return out


def _block(node: Node) -> list[str]:
    kind = node.type
    if kind == "heading":
        level = min(max(int(node.attrs.get("level") or 1), 1), 6)
        return ["#" * level + " " + _inline(node).strip()]
    if kind == "paragraph":
        text = _inline(node).strip()
        return [text] if text else []
    if kind in ("bulletList", "orderedList", "taskList"):
        lines = []
        for number, item in enumerate(node.children, start=1):
            marker = f"{number}." if kind == "orderedList" else "-"
            if item.type == "taskItem":
                checked = str(item.attrs.get("checked")).lower() == "true"
                marker += " [x]" if checked else " [ ]"
            inner = _blocks(item.children)
            if inner:
                lines.append(f"{marker} {inner[0]}")
                lines += ["   " + line for line in inner[1:]]
        return ["\n".join(lines)] if lines else []
    if kind == "codeBlock":
        language = node.attrs.get("language") or ""
        return [f"```{language}\n{_inline(node)}\n```"]
    if kind in ("blockquote", "callout"):
        inner = "\n".join(_blocks(node.children))
        return ["\n".join("> " + line for line in inner.splitlines())] if inner else []
    if kind == "horizontalRule":
        return ["---"]
    if kind == "image":
        return [f"![{node.attrs.get('alt') or ''}]({node.attrs.get('src') or ''})"]
    # Toggles (details/summary/content) and anything newer: their contents.
    if any(child.type != "text" for child in node.children):
        return _blocks(node.children)
    text = _inline(node).strip()
    return [text] if text else []


def to_markdown(nodes: list[Node]) -> list[str]:
    return _blocks(nodes)


def trim(blocks: list[str], budget: int) -> str:
    """Join the blocks, keeping every heading and as much of the rest, in order, as fits in `budget`.

    Text that doesn't fit is replaced by "…", so the model still sees the page's structure.
    """
    full = "\n\n".join(blocks)
    if len(full) <= budget:
        return full
    is_heading = [bool(re.match(r"#{1,6} ", block)) for block in blocks]
    room = budget - sum(len(b) + 2 for b, h in zip(blocks, is_heading, strict=True) if h)
    kept: list[str] = []
    for block, heading in zip(blocks, is_heading, strict=True):
        if heading:
            if len(block) + 2 <= budget:
                kept.append(block)
                budget -= len(block) + 2
            continue
        if len(block) + 2 <= room:
            kept.append(block)
            room -= len(block) + 2
            budget -= len(block) + 2
        elif not kept or kept[-1] != GAP:
            kept.append(GAP)
    return "\n\n".join(kept)
