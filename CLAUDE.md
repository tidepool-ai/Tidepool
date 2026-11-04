# Tidepool

Block-based workspace (Notion-style) with AI. Angular frontend, FastAPI backend, AI on a hosted GLM model (OpenAI-compatible API).

- Product spec: `docs/PRD.md` · Design system and tokens: `docs/DESIGN-SYSTEM.md` · Work queue: `docs/backlog.md`

## Layout

| Path | What |
| --- | --- |
| `web/` | Angular 22 app (standalone components, signals, Vitest, ESLint) |
| `api/` | FastAPI app (`app/`), tests in `api/tests`, Ruff for lint and format |
| `docs/` | PRD, design system, backlog |
| `.github/workflows/ci.yml` | CI: lint, test, build for both apps on every PR |

## Commands (run before opening a PR; all must pass)

```bash
# web
cd web && npm ci && npm run lint && npm run test:ci && npm run build
# api
cd api && pip install -r requirements-dev.txt && ruff check . && ruff format --check . && pytest -q
```

## How to work

1. Take **one** task from `docs/backlog.md` (lowest unchecked ID unless told otherwise). One task = one branch = one PR.
2. Branch name: `task/<ID>-<short-slug>`, e.g. `task/T03-theme-service`. Never commit or push to `main`.
3. Keep the change small and focused on the task's acceptance criteria. No drive-by refactors.
4. Add or update tests that prove the acceptance criteria.
5. Run the commands above until everything passes.
6. Tick the task in `docs/backlog.md` in the same PR.
7. Open a PR to `main` titled `<ID>: <task title>` with a short summary and how you verified it.
8. If something is ambiguous or blocked, stop and explain in the PR or session instead of guessing.

Do not edit `.github/`, lockfiles you did not need to change, or this file unless the task says so.

## Frontend rules (web/)

- Standalone components, `ChangeDetectionStrategy.OnPush`, `inject()` over constructor injection.
- State with signals (`signal`, `computed`, `effect`); NgRx SignalStore for shared feature state.
- Built-in control flow (`@if`, `@for`, `@switch`), no `*ngIf`/`*ngFor`.
- Styles use the CSS variables in `src/styles.scss` (`--color-*`, `--radius-*`), never raw hex.
- Feature folders: `src/app/features/<feature>/`; shared UI in `src/app/ui/`; services in `src/app/core/`.
- Accessible by default: real buttons and links, labels on inputs, `aria-label` on icon-only buttons, visible focus, 44px touch targets.
- Lazy-load feature routes.

## Backend rules (api/)

- One router per domain in `app/<domain>/router.py`, registered in `app/main.py`; schemas in `schemas.py`, DB models in `models.py`.
- Pydantic v2 models, full type hints, async endpoints.
- Every endpoint that reads or writes a page checks the caller's permission.
- Settings only through `app/config.py`; secrets come from env vars, never from code.
- AI calls (GLM) happen only on the server through the `openai` SDK with a custom `base_url`; never expose keys to the browser.

## Definition of done

- Acceptance criteria met and covered by tests.
- Lint, tests and build pass for every app you touched.
- Backlog task ticked, PR opened to `main`.
