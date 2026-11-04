# Tidepool

A block-based workspace with AI: nested pages, databases with Table and Board lenses, real-time collaboration, and AI writing and Q&A powered by a hosted GLM model.

| Part | Stack |
| --- | --- |
| `web/` | Angular 22 (standalone, signals), Vitest, ESLint |
| `api/` | Python 3.13, FastAPI, pytest, Ruff |
| AI | GLM via an OpenAI-compatible API, called only from `api/` |

## Docs

- [Product requirements](docs/PRD.md)
- [Design system (Tidepool tokens, 5 color schemes)](docs/DESIGN-SYSTEM.md)
- [Backlog](docs/backlog.md): the MVP as small, ordered, one-PR tasks
- [CLAUDE.md](CLAUDE.md): rules every coding session follows

## Run locally

```bash
# API: http://localhost:8000/health
cd api
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
uvicorn app.main:app --reload

# Web: http://localhost:4200
cd web
npm ci
npm start
```

## Checks (CI runs these on every PR)

```bash
cd web && npm run lint && npm run test:ci && npm run build
cd api && ruff check . && ruff format --check . && pytest -q
```

## How work gets done

Development runs in Claude Code cloud sessions started from the Claude app:

1. Start a session on this repo and ask it to implement the next task in `docs/backlog.md`.
2. The session works on a `task/<ID>-<slug>` branch, runs the checks, ticks the task and opens a PR.
3. CI runs on the PR; review and merge from the GitHub app.

Cloud sessions install dependencies automatically through the `SessionStart` hook in `.claude/settings.json` (`scripts/cloud-setup.sh`).
