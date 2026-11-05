# Deploying Tidepool

A free test deployment: **Neon** (Postgres) → **Render** (API) → **Vercel** (web app).

The web app forwards `/api/*` to the API (`web/vercel.json`), so the browser sees one site. That
keeps the `SameSite=Strict` refresh cookie working and avoids CORS setup.

> **Test deploys only, for now.** There is no email sender yet, so sign-in links are written to
> the API logs (`LOG_MAGIC_LINKS=true`). Anyone who can read the Render logs can sign in as any
> user. Turn it off (and add an email sender) before inviting other people.

## 1. Database: Neon

1. Create a project at [neon.tech](https://neon.tech) (Postgres 16 or newer).
2. On the dashboard, open **Connect**, turn **Connection pooling off**, and copy the connection
   string. It looks like
   `postgresql://user:password@ep-….neon.tech/neondb?sslmode=require&channel_binding=require`.
   Use it as is; the API converts it for its driver. (The pooled string breaks the driver's
   prepared statements.)

The first deploy creates the tables and enables the `ltree` extension, which Neon supports.

## 2. API: Render

1. At [render.com](https://render.com), **New → Blueprint**, connect this GitHub repo. Render reads
   `render.yaml` and proposes a free web service called `tidepool-api`.
2. Fill in the values it asks for:
   - `DATABASE_URL`: the Neon string from step 1.
   - `APP_URL` and `CORS_ORIGINS`: your Vercel URL from step 3 (for example
     `https://tidepool.vercel.app`). If you don't know it yet, enter a placeholder and update it
     after step 3; the service restarts on change.
   - `JWT_SECRET` is generated for you.
3. Deploy, then open `https://<service>.onrender.com/health`. It should return
   `{"status":"ok","database":"ok"}`.
4. If Render gave the service a different URL than the one in `web/vercel.json` (currently
   `https://tidepool-api-bspw.onrender.com`), change the `/api/:path*` destination there to match
   and push.

Free Render services sleep after 15 minutes without traffic; the first request afterwards can take
about a minute, and may time out once. Try again.

## 3. Web app: Vercel

1. At [vercel.com](https://vercel.com), **Add New → Project**, import this repo.
2. Set **Root Directory** to `web`. Everything else comes from `web/vercel.json`.
3. Deploy, then put the Vercel URL into `APP_URL` and `CORS_ORIGINS` on Render (step 2).

## 4. Try it

1. Open the Vercel URL and request a sign-in link.
2. In Render, open the service's **Logs** and find `Magic link for you@example.com: https://…`.
3. Open that link in the same browser. You land on Home with the page tree.

## Settings reference

All variables, with local setup and what to do if one leaks: [ENVIRONMENT.md](ENVIRONMENT.md).

| Variable | Where | Value |
| --- | --- | --- |
| `DATABASE_URL` | Render | Neon direct connection string |
| `JWT_SECRET` | Render | Generated; keep it secret. Changing it signs everyone out. |
| `APP_ENV` | Render | `production` |
| `APP_URL` | Render | Vercel URL, no trailing slash (used in sign-in links) |
| `CORS_ORIGINS` | Render | Vercel URL |
| `REFRESH_COOKIE_SECURE` | Render | `true` |
| `LOG_MAGIC_LINKS` | Render | `true` for a private test deploy only |
| `PYTHON_VERSION` | Render | Set by `render.yaml` |
