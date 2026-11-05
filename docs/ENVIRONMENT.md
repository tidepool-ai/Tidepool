# Environment variables and secrets

No secret is stored in this repository. Every secret comes from an environment variable, set in
a git-ignored `.env` file on your machine or in the hosting dashboard. The only credentials in the
repo are local and CI defaults (`tidepool` / `tidepool`) for throwaway databases that only listen
on your own machine or exist for one CI run.

## API variables (`api/`)

| Variable | Secret? | Required | Example / default | What it does |
| --- | --- | --- | --- | --- |
| `DATABASE_URL` | **Yes** (contains the DB password) | In deploys | `postgresql+asyncpg://tidepool:tidepool@localhost:5432/tidepool` locally | Postgres connection. Neon/Render strings (`postgresql://…?sslmode=require`) are accepted as is. |
| `JWT_SECRET` | **Yes** | Always | *(none)* | Signs access tokens. Long and random; changing it signs everyone out. |
| `APP_ENV` | No | No | `development` | `production` on deploys. |
| `APP_URL` | No | In deploys | `http://localhost:4200` | Web app URL, used to build sign-in links. No trailing slash. |
| `CORS_ORIGINS` | No | In deploys | `http://localhost:4200` | Comma-separated web app origins. |
| `REFRESH_COOKIE_SECURE` | No | No | `true` | Set `false` only for plain-http local dev. |
| `LOG_MAGIC_LINKS` | No, but see note | No | on in development | Writes sign-in links to the logs. Anyone who can read the logs can then sign in as anyone: private test deploys only. |
| `MAX_PAGE_CONTENT_BYTES` | No | No | `1000000` | Largest page document accepted, in bytes of JSON; bigger saves get `413`. |
| `TEST_DATABASE_URL` | Yes if set | No | `DATABASE_URL` + `_test` | Test database. It is **dropped and recreated** on every test run; its name must end in `_test`. |
| `GLM_BASE_URL`, `GLM_API_KEY`, `GLM_MODEL` | `GLM_API_KEY` **yes** | From T23 | *(empty)* | Hosted GLM model for AI features. The key stays on the server. |

Generate a `JWT_SECRET`:

```bash
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

The web app (`web/`) has no environment variables: it calls `/api` on its own origin, and the dev
server or Vercel forwards that to the API. Never put a secret in `web/`; everything there is
shipped to browsers.

## Where to set them

### On your machine

1. Copy the template and fill it in. `.env` is git-ignored, so it never gets committed.
   ```bash
   cp api/.env.example api/.env
   ```
2. Load it into your shell before running the API, migrations or tests (the app reads real
   environment variables; it does not read `.env` by itself):
   ```bash
   cd api
   set -a && . ./.env && set +a
   alembic upgrade head
   uvicorn app.main:app --reload
   ```
3. Optional: to change the local Docker database login, create a `.env` next to
   `docker-compose.yml` with `POSTGRES_USER`, `POSTGRES_PASSWORD` and `POSTGRES_DB`, and use the
   same values in `DATABASE_URL`.

Keep `DATABASE_URL` in `api/.env` pointed at your **local** database. Tests create and drop a
`<name>_test` database on whatever server it points to.

### On Render (API)

Dashboard → your service → **Environment**. `render.yaml` already lists the variables:
`JWT_SECRET` is generated, and you paste `DATABASE_URL`, `APP_URL` and `CORS_ORIGINS`. Saving
restarts the service. See [DEPLOY.md](DEPLOY.md).

### On Vercel (web)

Nothing to set.

### GitHub Actions (CI)

Nothing to set. CI uses a throwaway Postgres service and a dummy JWT secret from
`api/tests/__init__.py`. If a future task needs a real secret in CI, add it under
**Settings → Secrets and variables → Actions** and read it as `${{ secrets.NAME }}`; never write it
into the workflow file.

## If a secret leaks

| Leaked | Do this |
| --- | --- |
| Neon connection string | Neon → **Roles** → reset the role's password, copy the new string, update `DATABASE_URL` on Render. |
| `JWT_SECRET` | Render → Environment → generate a new value. Everyone is signed out; nothing else breaks. |
| `GLM_API_KEY` | Revoke it with the provider, create a new one, update Render. |
| Anything committed to git | Rotate it as above first. Deleting the commit is not enough once the repo is public. |
