# AI service

The API talks to the hosted GLM model through its OpenAI-compatible API with the `openai` Python SDK
(`api/app/ai/`). The key never reaches the browser. AI is off (503) until `GLM_BASE_URL`,
`GLM_API_KEY` and `GLM_MODEL` are set; limits are in [ENVIRONMENT.md](ENVIRONMENT.md).

## `POST /api/ai/complete`

Request (JSON): `{action, page_id, prompt?, selection?, tone?, language?}`. The caller needs edit
access to the page, and the page can't be in the trash.

| Action | Needs | Uses |
| --- | --- | --- |
| `write`, `brainstorm` | `prompt` | the page |
| `continue`, `summarize` | | the page |
| `improve`, `fix_grammar`, `shorter`, `longer`, `explain` | `selection` | the selection |
| `tone` | `selection`, `tone` (professional, casual, friendly, confident, direct) | the selection |
| `translate` | `selection`, `language` | the selection |

One prompt template per action (`app/ai/prompts.py`). The page goes to the model as Markdown: the live
document if it's open on this API worker, else the saved one (or content saved before live editing),
trimmed to `AI_CONTEXT_CHARS` with every heading kept and cut text replaced by "…". Page text and
selections are marked as content, and the model is told never to follow instructions inside them.

The answer streams as Server-Sent Events:

```
event: delta
data: {"text": "Hello"}

event: done
data: {"finish_reason": "stop", "usage": {"prompt_tokens": 40, "completion_tokens": 3, "total_tokens": 43}, "remaining": 199957}
```

If it stops part way, the last event is `event: error` with `{"code": "timeout" | "unavailable", "message"}`
(text already sent stays valid). Problems before the answer starts are plain HTTP errors: 503 (AI not
set up), 404 / 403 (page), 409 (page in the trash), 422 (request), 429 (quota used up, with
`Retry-After`), 502 (the model couldn't be reached), 504 (no answer within `AI_TIMEOUT_SECONDS`).

Closing the connection stops the answer (the web app's Stop button); what was generated still counts.

## Quota and usage log

Each person has `AI_DAILY_TOKEN_QUOTA` tokens (prompt + answer) per UTC day; answers are capped at
what's left. Every request is logged in `ai_usage` (person, workspace, page, action, model, tokens,
status: completed / stopped / timeout / failed, duration). When the provider reports no usage, tokens
are estimated at four characters each and the row is marked `exact = false`.

- `GET /api/ai/usage`: the caller's `used_today`, `quota`, `remaining`, `resets_at` and whether AI is on.
- `GET /api/workspaces/{id}/ai-usage?days=30`: requests and tokens per person and action (owners and
  admins only).

## Tests

`api/tests/test_ai.py` runs a fake OpenAI-compatible server on a local port and points the real SDK at
it: streaming, prompts and page context, access, validation, quota, timeouts (before and part way
through an answer), provider errors, Stop and the usage report.
