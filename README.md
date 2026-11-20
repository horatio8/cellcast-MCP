# Cellcast MCP

A remote [MCP](https://modelcontextprotocol.io) server plus webhook receivers for the
[Cellcast](https://developer.cellcast.com) SMS API, hosted as a single Next.js app on Vercel.

It uses an **event-sourcing** model: every SMS event (sent, delivered, received, opt-out)
is appended to an append-only **Events** table in Airtable. The **Inbound Messages**,
**Outbound Messages**, and **Contacts** tables are *projections* derived from that log.
Projections are written synchronously on each event, and `/api/rebuild` replays the whole
log to regenerate them from scratch.

## Endpoints

| Route | Purpose |
| --- | --- |
| `POST /api/mcp` | MCP server (Streamable HTTP). Works with any MCP client that can send a bearer token. |
| `POST /api/webhook/receive` | Inbound SMS replies (MO) → `sms.received` event. |
| `POST /api/webhook/status` | Delivery reports (DLR) → `sms.<status>` event. |
| `POST /api/webhook/optout` | Opt-outs → `sms.optout` event (marks Contact opted out). |
| `GET\|POST /api/rebuild` | Replay the Events log and rebuild all projections. |

## Data model (Airtable base "Cellcast SMS")

- **Events** — append-only source of truth. Type, Direction, Source, Message ID, From, To, Body, Status, Occurred At, Raw Payload, Processed.
- **Outbound Messages** — projection keyed by Message ID; status updated by delivery reports; linked to a Contact.
- **Inbound Messages** — projection of inbound replies; linked to a Contact.
- **Contacts** — projection keyed by phone; first/last seen, inbound/outbound counts, last message, opted-out flag.

## Client sub-accounts

Each client gets its own Cellcast sub-account with its own API key, so its inbox, sends and
balance stay separate. Every Cellcast tool takes an optional `account` argument naming the
client (for example `"Defend Sacred Ground"`). Leave it out, or pass `"main"`, for the main
account. Names ignore case, spaces and punctuation.

The connector finds a client's key in this order:

1. `CELLCAST_ACCOUNTS`, a JSON object of short name to API key, e.g.
   `{"dsg":"eyJ...","fairmigration":"eyJ..."}`.
2. The main account's sub-account token list in Cellcast, matched on the token name,
   sub-account name or company name. A new client works as soon as its sub-account has an
   active API token in Cellcast, with no redeploy.

`list_accounts` shows every name the connector can use. API keys are never returned to
the MCP client.

## MCP tools

- `list_accounts` — the main account plus each client sub-account
- `verify_token` — check the API key is valid
- `get_balance` — SMS / MMS credit balance
- `send_sms` — send to one or more numbers (logs an outbound event per recipient)
- `get_responses` — list inbound replies from Cellcast (paginated)
- `rebuild_projections` — replay the log to rebuild projections
- `cellcast_request` — call any other Cellcast endpoint (templates, MMS, sent messages, opt-outs, etc.)

## Environment variables

See `.env.example`. Set these in the Vercel project (Settings → Environment Variables):

| Variable | Required | Notes |
| --- | --- | --- |
| `CELLCAST_API_KEY` | yes | Cellcast Bearer token for the main account |
| `CELLCAST_ACCOUNTS` | no | JSON map of client name to that sub-account's API key; see "Client sub-accounts" |
| `AIRTABLE_TOKEN` | yes | PAT with `data.records:read` + `data.records:write` on the base |
| `AIRTABLE_BASE_ID` | yes | `apph4yvob8RzInWBO` |
| `AIRTABLE_EVENTS_TABLE` | no | defaults to `tbljkVscc97CQdyCf` |
| `AIRTABLE_INBOUND_TABLE` | no | defaults to `tblx3T7VZr5bPK1wj` |
| `AIRTABLE_OUTBOUND_TABLE` | no | defaults to `tblIkEXrwXEyWUnEt` |
| `AIRTABLE_CONTACTS_TABLE` | no | defaults to `tbl4z0286KnRwksIf` |
| `MCP_TOKEN` | yes (or `MCP_SECRET`) | access token(s), comma separated; clients send `Authorization: Bearer <token>` |
| `MCP_SECRET` | legacy | original shared secret; still accepted as a bearer token, `x-mcp-secret` header, or `?key=` |
| `WEBHOOK_USER` / `WEBHOOK_PASS` | optional | Basic Auth for the webhook routes |

## Connecting clients

The endpoint is `https://<your-vercel-domain>/api/mcp`. It speaks Streamable HTTP only and
serves both the 2026-07-28 MCP protocol and 2025-era clients from the same URL
(`mcp-handler` 2.x). `GET` and `DELETE` answer 405; there is no SSE transport.

Every request needs a token from `MCP_TOKEN` (or `MCP_SECRET`). If neither is set the
endpoint rejects all requests. Send it as:

```
Authorization: Bearer <token>
```

`MCP_TOKEN` can hold several comma separated tokens, so each client can have its own and
be revoked on its own.

| Client | How to pass the token |
| --- | --- |
| Anthropic API MCP connector | `mcp_servers[].authorization_token` |
| OpenAI Responses API `mcp` tool | `authorization` |
| xAI Responses API `mcp` tool | `authorization` |
| Gemini API / SDK | `headers: { "Authorization": "Bearer <token>" }` |
| Claude Code | `claude mcp add --transport http cellcast <url> --header "Authorization: Bearer <token>"` |
| Cursor, VS Code, Gemini CLI, MCP Inspector | `headers` entry `Authorization: Bearer <token>` in the MCP config |
| Copilot Studio | API key auth, header `Authorization`, value `Bearer <token>` |
| Claude custom connector | `https://<your-vercel-domain>/api/mcp?key=<MCP_SECRET>` (legacy URL form) |

The `?key=` URL form and the `x-mcp-secret` header exist for connectors created before
bearer tokens were supported. Prefer the header for anything new: URLs end up in logs.

ChatGPT connectors only accept OAuth or no auth, so they cannot use this server until an
OAuth authorization server is added.

## Configure Cellcast webhooks

Cellcast dashboard → API → API KEYS → Webhook. Set all three:

- Receiver: `https://<your-vercel-domain>/api/webhook/receive`
- Status: `https://<your-vercel-domain>/api/webhook/status`
- Opt-Out: `https://<your-vercel-domain>/api/webhook/optout`

If you set `WEBHOOK_USER` / `WEBHOOK_PASS`, enter the same credentials in the dashboard's webhook security fields.

## Local development

```bash
npm install
cp .env.example .env.local   # fill in values
npm run dev
```
