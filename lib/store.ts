// Event store + projections for the Cellcast SMS base.
//
// Architecture: every inbound/outbound/opt-out event is appended to the
// append-only "Events" table (source of truth). Projections (Inbound
// Messages, Outbound Messages, Contacts) are derived from those events.
// Live ingestion projects synchronously; /api/rebuild replays the whole
// log to regenerate the projections from scratch.

import { atCreate, atUpdate, atFindOne, atListAll, AirtableRecord } from "./airtable";
import { normalizePhone } from "./phone";

export const TABLES = {
  events: process.env.AIRTABLE_EVENTS_TABLE || "tbljkVscc97CQdyCf",
  inbound: process.env.AIRTABLE_INBOUND_TABLE || "tblx3T7VZr5bPK1wj",
  outbound: process.env.AIRTABLE_OUTBOUND_TABLE || "tblIkEXrwXEyWUnEt",
  contacts: process.env.AIRTABLE_CONTACTS_TABLE || "tbl4z0286KnRwksIf",
};

export type Direction = "inbound" | "outbound";
export type Source =
  | "mcp-send"
  | "webhook-receive"
  | "webhook-status"
  | "webhook-optout"
  | "rebuild";

export interface DomainEvent {
  type: string; // sms.sent | sms.received | sms.delivered | sms.optout | ...
  direction: Direction;
  source: Source;
  messageId?: string;
  from?: string;
  to?: string;
  body?: string;
  status?: string;
  occurredAt?: string; // ISO; defaults to now
  raw?: unknown;
}

const OUTBOUND_STATUSES = new Set([
  "queued",
  "sent",
  "delivered",
  "failed",
  "expired",
  "rejected",
  "dead",
  "received",
]);

export function statusToType(status: string | undefined): string {
  const s = (status || "").toLowerCase();
  if (["delivered", "received", "expired", "dead", "rejected", "failed"].includes(s)) {
    return `sms.${s}`;
  }
  return "sms.unknown";
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
}

// ---------- Append-only log ----------

export async function appendEvent(ev: DomainEvent): Promise<AirtableRecord> {
  const occurredAt = ev.occurredAt || new Date().toISOString();
  const eventId = `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return atCreate(TABLES.events, {
    "Event ID": eventId,
    Type: ev.type,
    Direction: ev.direction,
    Source: ev.source,
    "Message ID": ev.messageId,
    From: ev.from,
    To: ev.to,
    Body: ev.body,
    Status: ev.status,
    "Occurred At": occurredAt,
    "Raw Payload": ev.raw ? JSON.stringify(ev.raw) : undefined,
    Processed: false,
  });
}

// Append an event AND project it synchronously. Used by all live ingress.
export async function ingestEvent(ev: DomainEvent): Promise<void> {
  const occurredAt = ev.occurredAt || new Date().toISOString();
  const record = await appendEvent({ ...ev, occurredAt });
  try {
    await projectEvent({ ...ev, occurredAt }, { incrementCounts: true });
    await atUpdate(TABLES.events, record.id, {
      Processed: true,
      "Processed At": new Date().toISOString(),
    });
  } catch (e) {
    // Leave Processed = false so /api/rebuild can reconcile later.
    console.error("projection failed for event", record.id, (e as Error).message);
    throw e;
  }
}

// ---------- Projection (single event) ----------

async function upsertContact(args: {
  phone: string;
  direction: Direction;
  occurredAt: string;
  lastMessage?: string;
  optedOut?: boolean;
  incrementCounts: boolean;
}): Promise<string | null> {
  const phone = normalizePhone(args.phone);
  if (!phone) return null;

  const existing = await atFindOne(TABLES.contacts, "Phone", phone);
  if (existing) {
    const fields: Record<string, unknown> = {
      "Last Seen": args.occurredAt,
      "Last Direction": args.direction,
    };
    if (args.lastMessage) fields["Last Message"] = args.lastMessage;
    if (args.incrementCounts) {
      if (args.direction === "inbound") {
        fields["Inbound Count"] = num(existing.fields["Inbound Count"]) + 1;
      } else {
        fields["Outbound Count"] = num(existing.fields["Outbound Count"]) + 1;
      }
    }
    if (args.optedOut) {
      fields["Opted Out"] = true;
      fields["Opted Out At"] = args.occurredAt;
    }
    await atUpdate(TABLES.contacts, existing.id, fields);
    return existing.id;
  }

  const created = await atCreate(TABLES.contacts, {
    Phone: phone,
    "First Seen": args.occurredAt,
    "Last Seen": args.occurredAt,
    "Last Direction": args.direction,
    "Last Message": args.lastMessage,
    "Inbound Count": args.incrementCounts && args.direction === "inbound" ? 1 : 0,
    "Outbound Count": args.incrementCounts && args.direction === "outbound" ? 1 : 0,
    "Opted Out": args.optedOut ? true : undefined,
    "Opted Out At": args.optedOut ? args.occurredAt : undefined,
  });
  return created.id;
}

async function upsertOutbound(args: {
  messageId: string;
  to?: string;
  sender?: string;
  body?: string;
  status: string;
  occurredAt: string;
  isSend: boolean; // true for the original send, false for a status update
  contactId: string | null;
}): Promise<void> {
  const status = OUTBOUND_STATUSES.has((args.status || "").toLowerCase())
    ? args.status.toLowerCase()
    : "sent";

  const existing = await atFindOne(TABLES.outbound, "Message ID", args.messageId);
  if (existing) {
    const fields: Record<string, unknown> = {
      Status: status,
      "Last Status At": args.occurredAt,
    };
    if (!existing.fields["To"] && args.to) fields["To"] = args.to;
    if (!existing.fields["Sender"] && args.sender) fields["Sender"] = args.sender;
    if (!existing.fields["Body"] && args.body) fields["Body"] = args.body;
    if (args.contactId && !existing.fields["Contact"]) fields["Contact"] = [args.contactId];
    await atUpdate(TABLES.outbound, existing.id, fields);
    return;
  }

  await atCreate(TABLES.outbound, {
    "Message ID": args.messageId,
    To: args.to,
    Sender: args.sender,
    Body: args.body,
    Status: status,
    "Sent At": args.isSend ? args.occurredAt : undefined,
    "Last Status At": args.occurredAt,
    Contact: args.contactId ? [args.contactId] : undefined,
  });
}

async function upsertInbound(args: {
  messageId: string;
  occurredAt: string;
  contactId: string | null;
  raw: Record<string, unknown>;
}): Promise<void> {
  const p = args.raw;
  const key = args.messageId || `mo_${Date.parse(args.occurredAt) || Date.now()}`;
  const existing = await atFindOne(TABLES.inbound, "Message ID", key);
  const fields: Record<string, unknown> = {
    "Message ID": key,
    Status: p.status,
    Type: p.type,
    Message: p.message,
    Reply: p.reply,
    Sender: p.sender,
    Receiver: p.receiver,
    "Received At": args.occurredAt,
    "Raw Payload": JSON.stringify(p),
    Contact: args.contactId ? [args.contactId] : undefined,
  };
  if (existing) {
    await atUpdate(TABLES.inbound, existing.id, fields);
  } else {
    await atCreate(TABLES.inbound, fields);
  }
}

export async function projectEvent(
  ev: DomainEvent,
  opts: { incrementCounts: boolean }
): Promise<void> {
  const occurredAt = ev.occurredAt || new Date().toISOString();
  const isOptOut = ev.type === "sms.optout" || ev.type.endsWith(".optout");
  const isInbound = ev.direction === "inbound";

  const contactPhone = isInbound ? ev.from : ev.to;
  const contactId = await upsertContact({
    phone: contactPhone || "",
    direction: ev.direction,
    occurredAt,
    lastMessage: ev.body,
    optedOut: isOptOut,
    // opt-out is not a message; don't inflate message counts
    incrementCounts: opts.incrementCounts && !isOptOut,
  });

  if (isOptOut) return;

  if (ev.direction === "outbound" && ev.messageId) {
    await upsertOutbound({
      messageId: ev.messageId,
      to: ev.to,
      sender: ev.from,
      body: ev.body,
      status: ev.status || (ev.type === "sms.sent" ? "sent" : "sent"),
      occurredAt,
      isSend: ev.type === "sms.sent" || ev.type === "sms.queued",
      contactId,
    });
  }

  if (ev.direction === "inbound" && ev.type === "sms.received") {
    await upsertInbound({
      messageId: ev.messageId || "",
      occurredAt,
      contactId,
      raw: (ev.raw as Record<string, unknown>) || {},
    });
  }
}

// ---------- Full replay (rebuild projections from the log) ----------

interface ContactAgg {
  phone: string;
  firstSeen: string;
  lastSeen: string;
  lastDirection: Direction;
  inbound: number;
  outbound: number;
  lastMessage?: string;
  optedOut: boolean;
  optedOutAt?: string;
}

interface OutboundAgg {
  messageId: string;
  to?: string;
  sender?: string;
  body?: string;
  status: string;
  sentAt?: string;
  lastStatusAt: string;
  phone?: string;
}

interface InboundAgg {
  key: string;
  occurredAt: string;
  phone?: string;
  raw: Record<string, unknown>;
}

function eventFromRecord(r: AirtableRecord): DomainEvent & { occurredAt: string } {
  const f = r.fields;
  let raw: unknown = {};
  try {
    raw = f["Raw Payload"] ? JSON.parse(String(f["Raw Payload"])) : {};
  } catch {
    raw = {};
  }
  return {
    type: String(f["Type"] || "sms.unknown"),
    direction: (String(f["Direction"] || "outbound") as Direction),
    source: "rebuild",
    messageId: f["Message ID"] ? String(f["Message ID"]) : undefined,
    from: f["From"] ? String(f["From"]) : undefined,
    to: f["To"] ? String(f["To"]) : undefined,
    body: f["Body"] ? String(f["Body"]) : undefined,
    status: f["Status"] ? String(f["Status"]) : undefined,
    occurredAt: String(f["Occurred At"] || r.createdTime || new Date().toISOString()),
    raw,
  };
}

// Replays the entire Events log and rewrites the projection tables with
// absolute (recomputed) values. Idempotent: safe to run repeatedly.
export async function rebuildProjections(): Promise<{
  events: number;
  contacts: number;
  outbound: number;
  inbound: number;
}> {
  const records = await atListAll(TABLES.events, {
    sortField: "Occurred At",
    sortDir: "asc",
  });

  const contacts = new Map<string, ContactAgg>();
  const outbound = new Map<string, OutboundAgg>();
  const inbound = new Map<string, InboundAgg>();

  const touchContact = (
    phoneRaw: string | undefined,
    direction: Direction,
    occurredAt: string,
    lastMessage: string | undefined,
    isOptOut: boolean,
    countable: boolean
  ): string | undefined => {
    const phone = normalizePhone(phoneRaw);
    if (!phone) return undefined;
    const c =
      contacts.get(phone) ||
      ({
        phone,
        firstSeen: occurredAt,
        lastSeen: occurredAt,
        lastDirection: direction,
        inbound: 0,
        outbound: 0,
        optedOut: false,
      } as ContactAgg);
    if (occurredAt < c.firstSeen) c.firstSeen = occurredAt;
    if (occurredAt >= c.lastSeen) {
      c.lastSeen = occurredAt;
      c.lastDirection = direction;
      if (lastMessage) c.lastMessage = lastMessage;
    }
    if (countable) {
      if (direction === "inbound") c.inbound += 1;
      else c.outbound += 1;
    }
    if (isOptOut) {
      c.optedOut = true;
      c.optedOutAt = occurredAt;
    }
    contacts.set(phone, c);
    return phone;
  };

  for (const r of records) {
    const ev = eventFromRecord(r);
    const isOptOut = ev.type === "sms.optout" || ev.type.endsWith(".optout");
    const isInbound = ev.direction === "inbound";
    const phone = touchContact(
      isInbound ? ev.from : ev.to,
      ev.direction,
      ev.occurredAt,
      ev.body,
      isOptOut,
      !isOptOut
    );

    if (isOptOut) continue;

    if (ev.direction === "outbound" && ev.messageId) {
      const o =
        outbound.get(ev.messageId) ||
        ({
          messageId: ev.messageId,
          status: "sent",
          lastStatusAt: ev.occurredAt,
        } as OutboundAgg);
      if (ev.to && !o.to) o.to = ev.to;
      if (ev.from && !o.sender) o.sender = ev.from;
      if (ev.body && !o.body) o.body = ev.body;
      if (phone && !o.phone) o.phone = phone;
      if (ev.type === "sms.sent" || ev.type === "sms.queued") {
        o.sentAt = o.sentAt || ev.occurredAt;
        if (o.status === "sent" || !o.status) o.status = "sent";
      }
      const st = (ev.status || "").toLowerCase();
      if (OUTBOUND_STATUSES.has(st)) {
        if (ev.occurredAt >= o.lastStatusAt) o.status = st;
      }
      if (ev.occurredAt >= o.lastStatusAt) o.lastStatusAt = ev.occurredAt;
      outbound.set(ev.messageId, o);
    }

    if (ev.direction === "inbound" && ev.type === "sms.received") {
      const key = ev.messageId || `mo_${Date.parse(ev.occurredAt) || Date.now()}`;
      inbound.set(key, {
        key,
        occurredAt: ev.occurredAt,
        phone,
        raw: (ev.raw as Record<string, unknown>) || {},
      });
    }
  }

  // Write contacts first so we can link by record id.
  const contactIdByPhone = new Map<string, string>();
  for (const c of contacts.values()) {
    const existing = await atFindOne(TABLES.contacts, "Phone", c.phone);
    const fields: Record<string, unknown> = {
      Phone: c.phone,
      "First Seen": c.firstSeen,
      "Last Seen": c.lastSeen,
      "Last Direction": c.lastDirection,
      "Inbound Count": c.inbound,
      "Outbound Count": c.outbound,
      "Last Message": c.lastMessage,
      "Opted Out": c.optedOut,
      "Opted Out At": c.optedOutAt,
    };
    const rec = existing
      ? await atUpdate(TABLES.contacts, existing.id, fields)
      : await atCreate(TABLES.contacts, fields);
    contactIdByPhone.set(c.phone, rec.id);
  }

  for (const o of outbound.values()) {
    const contactId = o.phone ? contactIdByPhone.get(o.phone) : undefined;
    const existing = await atFindOne(TABLES.outbound, "Message ID", o.messageId);
    const fields: Record<string, unknown> = {
      "Message ID": o.messageId,
      To: o.to,
      Sender: o.sender,
      Body: o.body,
      Status: o.status,
      "Sent At": o.sentAt,
      "Last Status At": o.lastStatusAt,
      Contact: contactId ? [contactId] : undefined,
    };
    if (existing) await atUpdate(TABLES.outbound, existing.id, fields);
    else await atCreate(TABLES.outbound, fields);
  }

  for (const i of inbound.values()) {
    const contactId = i.phone ? contactIdByPhone.get(i.phone) : undefined;
    const existing = await atFindOne(TABLES.inbound, "Message ID", i.key);
    const fields: Record<string, unknown> = {
      "Message ID": i.key,
      Status: i.raw.status,
      Type: i.raw.type,
      Message: i.raw.message,
      Reply: i.raw.reply,
      Sender: i.raw.sender,
      Receiver: i.raw.receiver,
      "Received At": i.occurredAt,
      "Raw Payload": JSON.stringify(i.raw),
      Contact: contactId ? [contactId] : undefined,
    };
    if (existing) await atUpdate(TABLES.inbound, existing.id, fields);
    else await atCreate(TABLES.inbound, fields);
  }

  return {
    events: records.length,
    contacts: contacts.size,
    outbound: outbound.size,
    inbound: inbound.size,
  };
}
