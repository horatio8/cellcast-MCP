import { checkBasicAuth, unauthorized } from "../../../../lib/auth";
import { ingestEvent } from "../../../../lib/store";

export const dynamic = "force-dynamic";

// Cellcast "Opt-Out" webhook: fired when a recipient opts out (e.g. replies STOP).
// Cellcast's opt-out payload shape isn't formally documented, so we extract the
// phone number from the most likely fields and stash the full payload.
export async function POST(req: Request) {
  if (!checkBasicAuth(req)) return unauthorized();

  let p: Record<string, unknown> = {};
  try {
    p = (await req.json()) as Record<string, unknown>;
  } catch {
    p = {};
  }

  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = p[k];
      if (v !== undefined && v !== null && String(v).trim() !== "") return String(v);
    }
    return undefined;
  };

  const number = pick("number", "contact", "sender", "mobile", "msisdn", "receiver", "optout");

  try {
    await ingestEvent({
      type: "sms.optout",
      direction: "inbound",
      source: "webhook-optout",
      messageId: pick("_id", "message_id"),
      from: number,
      status: "optout",
      raw: p,
    });
  } catch (e) {
    console.error("optout webhook failed:", (e as Error).message);
    return Response.json({ ok: false, error: (e as Error).message });
  }

  return Response.json({ ok: true });
}

export async function GET() {
  return Response.json({ ok: true, endpoint: "optout" });
}
