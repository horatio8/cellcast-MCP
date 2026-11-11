import { rebuildProjections } from "../../../lib/store";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

// Replays the Events log and regenerates the projection tables.
// Protected by MCP_SECRET (pass ?key=<MCP_SECRET>) when that env var is set.
function guard(req: Request): Response | null {
  const secret = process.env.MCP_SECRET;
  if (!secret) return null;
  const url = new URL(req.url);
  const provided = url.searchParams.get("key") || req.headers.get("x-mcp-secret");
  if (provided !== secret) return new Response("Unauthorized", { status: 401 });
  return null;
}

async function run() {
  const summary = await rebuildProjections();
  return Response.json({ ok: true, ...summary });
}

export async function POST(req: Request) {
  const blocked = guard(req);
  if (blocked) return blocked;
  try {
    return await run();
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

// Allow triggering from a browser too.
export async function GET(req: Request) {
  const blocked = guard(req);
  if (blocked) return blocked;
  try {
    return await run();
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
