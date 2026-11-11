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
| `POST /api/mcp` | MCP server. Add as a custom connector in Claude. |
| `POST /api/webhook/receive` | Inbound SMS replies (MO) → `sms.received` event. |
| `POST /api/webhook/status` | Delivery reports (DLR) → `sms.<status>` event. |
| `POST /api/webhook/optout` | Opt-outs → `sms.optout` event (marks Contact opted out). |
| `GET\|POST /api/rebuild` | Replay the Events log and rebuild all projections. |

## Data model (Airtable base "Cellcast SMS")

- **Events** — append-only source of truth. Type, Direction, Source, Message ID, From, To, Body, Status, Occurred At, Raw Payload, Processed.
- **Outbound Messages** — projection keyed by Message ID; status updated by delivery reports; linked to a Contact.
- **Inbound Messages** — projection of inbound replies; linked to a Contact.
- **Contacts** — projection keyed by phone; first/last seen, inbound/outbound counts, last message, opted-out flag.

## MCP tools

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
| `CELLCAST_API_KEY` | yes | Cellcast Bearer token |
| `AIRTABLE_TOKEN` | yes | PAT with `data.records:read` + `data.records:write` on the base |
| `AIRTABLE_BASE_ID` | yes | `apph4yvob8RzInWBO` |
| `AIRTABLE_EVENTS_TABLE` | no | defaults to `tbljkVscc97CQdyCf` |
| `AIRTABLE_INBOUND_TABLE` | no | defaults to `tblx3T7VZr5bPK1wj` |
| `AIRTABLE_OUTBOUND_TABLE` | no | defaults to `tblIkEXrwXEyWUnEt` |
| `AIRTABLE_CONTACTS_TABLE` | no | defaults to `tbl4z0286KnRwksIf` |
| `MCP_SECRET` | recommended | shared secret; pass as `?key=` on the MCP and rebuild URLs |
| `WEBHOOK_USER` / `WEBHOOK_PASS` | optional | Basic Auth for the webhook routes |

## Connect in Claude

Add a custom connector pointing at:

```
https://<your-vercel-domain>/api/mcp?key=<MCP_SECRET>
```

(Omit `?key=...` if `MCP_SECRET` is not set.)

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
