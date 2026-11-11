import { checkBasicAuth, unauthorized } from "../../../../lib/auth";
import { ingestEvent, statusToType } from "../../../../lib/store";

export const dynamic = "force-dynamic";

// Cellcast "Status" webhook: delivery reports (DLR).
// payload: { _id, status, type:"send", sender, receiver }
// Updates the matching Outbound Messages row by Message ID (_id).
export async function POST(req: Request) {
  if (!checkBasicAuth(req)) return unauthorized();

  let p: Record<string, unknown> = {};
  try {
    p = (await req.json()) as Record<string, unknown>;
  } catch {
    p = {};
  }

  const status = p.status ? String(p.status) : undefined;

  try {
    await ingestEvent({
      type: statusToType(status),
      direction: "outbound",
      source: "webhook-status",
      messageId: p._id ? String(p._id) : undefined,
      from: p.sender ? String(p.sender) : undefined,
      to: p.receiver ? String(p.receiver) : undefined,
      status,
      raw: p,
    });
  } catch (e) {
    console.error("status webhook failed:", (e as Error).message);
    return Response.json({ ok: false, error: (e as Error).message });
  }

  return Response.json({ ok: true });
}

export async function GET() {
  return Response.json({ ok: true, endpoint: "status" });
}
