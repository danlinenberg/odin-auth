# odin-auth worker

Holds Odin's OAuth client secrets so a distributed build doesn't have to.

Slack and Notion both require a client secret at the token exchange, and
neither supports PKCE — so any desktop build that ships one hands it to anyone
with the bundle. This Worker is the registered redirect URI, performs the
exchange itself, and gives the app a single-use handoff id. The app never sees
a secret, and the token never travels in a URL.

## Deploy

```bash
cd worker
bun install
bunx wrangler login

# KV holds only in-flight handoffs (10-minute TTL, deleted on collection).
bunx wrangler kv namespace create HANDOFF     # copy the id into wrangler.toml

# Public identifiers — fine in wrangler.toml
#   SLACK_CLIENT_ID, NOTION_CLIENT_ID
# Secrets — never in the file
bunx wrangler secret put SLACK_CLIENT_SECRET
bunx wrangler secret put NOTION_CLIENT_SECRET

bunx wrangler deploy
```

## Then point the providers and the app at it

Register these as redirect URIs, replacing the host with your deployed one:

| Provider | Redirect URI |
|---|---|
| Slack | `https://odin-auth.<you>.workers.dev/slack/callback` |
| Notion | `https://odin-auth.<you>.workers.dev/notion/callback` |

And build Odin with the Worker's base URL — no secrets:

```bash
ODIN_SLACK_CLIENT_ID=... \
ODIN_NOTION_CLIENT_ID=... \
ODIN_AUTH_WORKER_URL=https://odin-auth.<you>.workers.dev \
  bun run build
```

Odin uses the Worker whenever `ODIN_AUTH_WORKER_URL` is set and no local client
secret is configured. A machine that *does* have a secret in `odin.json` keeps
exchanging locally, so an existing setup doesn't change.

## Endpoints

| Path | Purpose |
|---|---|
| `GET /slack/callback` | exchange, then `302 odin://oauth/slack?handoff=…&state=…` |
| `GET /notion/callback` | same for Notion; returns access + refresh together |
| `POST /handoff` | `{id}` → `{token, identity}`, deleting the entry |

Failures are forwarded to the app as `?error=…` rather than shown as a page, so
Odin stops waiting instead of polling until it times out.
