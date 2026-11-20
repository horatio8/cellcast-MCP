// Thin client for the Cellcast API. API keys live only on the server: the main
// account's in CELLCAST_API_KEY, client sub-accounts' as described in
// lib/accounts.ts.

import { resolveApiKey } from "./accounts";

const BASE_URL = "https://api.cellcast.com/api/v1";

export type CellcastMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export async function cellcast(
  method: CellcastMethod,
  path: string,
  body?: unknown,
  account?: string
): Promise<unknown> {
  const apiKey = await resolveApiKey(account);

  const url = `${BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;

  const res = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });

  const raw = await res.text();
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    parsed = { raw };
  }

  if (!res.ok) {
    return { ok: false, httpStatus: res.status, response: parsed };
  }
  return parsed;
}
