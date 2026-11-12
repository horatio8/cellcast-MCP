// Shared-token guard for the MCP endpoint and /api/rebuild.
//
// Tokens come from Vercel environment variables:
//   MCP_TOKEN   one or more tokens, comma separated (one per client is a good idea)
//   MCP_SECRET  the original shared secret, still accepted
//
// A caller may present any configured token in one of three ways:
//   Authorization: Bearer <token>   the standard, works with every MCP client
//   x-mcp-secret: <token>           legacy header
//   ?key=<token>                    legacy URL form used by the existing Claude connector
//
// If no token is configured the endpoint refuses every request instead of
// running open.

import { createHash, timingSafeEqual } from "node:crypto";

function configuredTokens(): string[] {
  return [process.env.MCP_TOKEN, process.env.MCP_SECRET]
    .flatMap((v) => (v ? v.split(",") : []))
    .map((t) => t.trim())
    .filter(Boolean);
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function matches(provided: string, tokens: string[]): boolean {
  const p = digest(provided);
  let ok = false;
  for (const t of tokens) {
    if (timingSafeEqual(p, digest(t))) ok = true;
  }
  return ok;
}

function presented(req: Request): string | null {
  const auth = req.headers.get("authorization") || "";
  const bearer = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (bearer) return bearer[1].trim();
  const header = req.headers.get("x-mcp-secret");
  if (header) return header.trim();
  return new URL(req.url).searchParams.get("key");
}

function deny(status: number, error: string, description: string): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "WWW-Authenticate": `Bearer realm="cellcast-mcp", error="${error}", error_description="${description}"`,
    },
  });
}

// Returns a 401 response to send, or null when the request is authorised.
export function requireToken(req: Request): Response | null {
  const tokens = configuredTokens();
  if (tokens.length === 0) {
    return deny(401, "invalid_token", "No access token is configured on the server. Set MCP_TOKEN.");
  }
  const provided = presented(req);
  if (!provided) {
    return deny(401, "invalid_request", "Missing access token. Send Authorization: Bearer <token>.");
  }
  if (!matches(provided, tokens)) {
    return deny(401, "invalid_token", "The access token is not valid.");
  }
  return null;
}
