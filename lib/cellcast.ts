// Thin client for the Cellcast API. The API key lives only on the server
// (Vercel environment variable CELLCAST_API_KEY).

const BASE_URL = "https://api.cellcast.com/api/v1";

export type CellcastMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export async function cellcast(
  method: CellcastMethod,
  path: string,
  body?: unknown
): Promise<unknown> {
  const apiKey = process.env.CELLCAST_API_KEY;
  if (!apiKey) {
    throw new Error("CELLCAST_API_KEY environment variable is not set.");
  }

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
