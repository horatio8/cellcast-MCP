import { requireToken } from "../../../lib/mcpAuth";
import { rebuildProjections } from "../../../lib/store";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

// Replays the Events log and regenerates the projection tables.
// Protected by the same token as the MCP endpoint (see lib/mcpAuth.ts).
const guard = requireToken;

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
