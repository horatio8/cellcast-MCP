// Generic Airtable REST helpers for the "Cellcast SMS" base.
// Requires AIRTABLE_TOKEN (PAT with data.records:read + data.records:write)
// and AIRTABLE_BASE_ID.

const AIRTABLE_API = "https://api.airtable.com/v0";

function cfg() {
  const baseId = process.env.AIRTABLE_BASE_ID;
  const token = process.env.AIRTABLE_TOKEN;
  if (!baseId || !token) {
    throw new Error("AIRTABLE_BASE_ID and AIRTABLE_TOKEN must be set.");
  }
  return { baseId, token };
}

export interface AirtableRecord {
  id: string;
  fields: Record<string, unknown>;
  createdTime?: string;
}

function stripEmpty(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null && v !== "") out[k] = v;
  }
  return out;
}

export async function atCreate(
  table: string,
  fields: Record<string, unknown>
): Promise<AirtableRecord> {
  const { baseId, token } = cfg();
  const res = await fetch(`${AIRTABLE_API}/${baseId}/${encodeURIComponent(table)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: stripEmpty(fields), typecast: true }),
  });
  if (!res.ok) throw new Error(`Airtable create ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function atUpdate(
  table: string,
  recordId: string,
  fields: Record<string, unknown>
): Promise<AirtableRecord> {
  const { baseId, token } = cfg();
  const res = await fetch(
    `${AIRTABLE_API}/${baseId}/${encodeURIComponent(table)}/${recordId}`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields: stripEmpty(fields), typecast: true }),
    }
  );
  if (!res.ok) throw new Error(`Airtable update ${res.status}: ${await res.text()}`);
  return res.json();
}

function escapeFormulaValue(v: string): string {
  return v.replace(/"/g, '\\"');
}

// Find a single record where {field} = value. Returns null if none.
export async function atFindOne(
  table: string,
  field: string,
  value: string
): Promise<AirtableRecord | null> {
  const { baseId, token } = cfg();
  const formula = `{${field}}="${escapeFormulaValue(value)}"`;
  const url = `${AIRTABLE_API}/${baseId}/${encodeURIComponent(
    table
  )}?maxRecords=1&filterByFormula=${encodeURIComponent(formula)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Airtable find ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { records: AirtableRecord[] };
  return data.records[0] ?? null;
}

// List every record in a table, following pagination. Optional sort.
export async function atListAll(
  table: string,
  opts?: { sortField?: string; sortDir?: "asc" | "desc" }
): Promise<AirtableRecord[]> {
  const { baseId, token } = cfg();
  const out: AirtableRecord[] = [];
  let offset: string | undefined;
  do {
    const params = new URLSearchParams({ pageSize: "100" });
    if (opts?.sortField) {
      params.set("sort[0][field]", opts.sortField);
      params.set("sort[0][direction]", opts.sortDir ?? "asc");
    }
    if (offset) params.set("offset", offset);
    const url = `${AIRTABLE_API}/${baseId}/${encodeURIComponent(table)}?${params}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Airtable list ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { records: AirtableRecord[]; offset?: string };
    out.push(...data.records);
    offset = data.offset;
  } while (offset);
  return out;
}
