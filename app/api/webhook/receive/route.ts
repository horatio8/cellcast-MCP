import { checkBasicAuth, unauthorized } from "../../../../lib/auth";
import { ingestEvent } from "../../../../lib/store";

export const dynamic = "force-dynamic";

// Cellcast "Receiver" webhook: inbound SMS (MO).
// payload: { _id, status, type:"receive", message, sender, receiver, reply }
// sender = the customer, receiver = your number, reply = the customer's text.
export async function POST(req: Request) {
  if (!checkBasicAuth(req)) return unauthorized();

  let p: Record<string, unknown> = {};
  try {
    p = (await req.json()) as Record<string, unknown>;
  } catch {
    p = {};
  }

  try {
    await ingestEvent({
      type: "sms.received",
      direction: "inbound",
      source: "webhook-receive",
      messageId: p._id ? String(p._id) : undefined,
      from: p.sender ? String(p.sender) : undefined,
      to: p.receiver ? String(p.receiver) : undefined,
      body: p.reply ? String(p.reply) : p.message ? String(p.message) : undefined,
      status: p.status ? String(p.status) : "received",
      raw: p,
    });
  } catch (e) {
    console.error("receive webhook failed:", (e as Error).message);
    return Response.json({ ok: false, error: (e as Error).message });
  }

  return Response.json({ ok: true });
}

export async function GET() {
  return Response.json({ ok: true, endpoint: "receive" });
}
