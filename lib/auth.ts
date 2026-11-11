// Basic Auth check for the webhook routes. Cellcast can attach Basic Auth
// credentials to webhook calls (see Webhook Security in the docs).
// If WEBHOOK_USER / WEBHOOK_PASS are unset, auth is skipped.

export function checkBasicAuth(req: Request): boolean {
  const user = process.env.WEBHOOK_USER;
  const pass = process.env.WEBHOOK_PASS;
  if (!user && !pass) return true;

  const header = req.headers.get("authorization") || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) return false;

  let decoded = "";
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return false;
  }
  const idx = decoded.indexOf(":");
  if (idx === -1) return false;
  const u = decoded.slice(0, idx);
  const p = decoded.slice(idx + 1);
  return u === user && p === pass;
}

export function unauthorized(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="cellcast-webhook"' },
  });
}
