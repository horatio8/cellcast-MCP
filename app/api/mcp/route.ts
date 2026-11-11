import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { cellcast } from "../../../lib/cellcast";
import { ingestEvent, rebuildProjections } from "../../../lib/store";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

function asText(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

const handler = createMcpHandler(
  (server) => {
    server.tool(
      "verify_token",
      "Verify that the configured Cellcast API token is valid.",
      {},
      async () => asText(await cellcast("GET", "/user/token/verify"))
    );

    server.tool(
      "get_balance",
      "Get the Cellcast account's SMS and MMS balance.",
      {},
      async () => asText(await cellcast("GET", "/apiClient/account"))
    );

    server.tool(
      "send_sms",
      "Send an SMS to one or more recipients via Cellcast. Each accepted recipient is logged as an outbound event and projected into Outbound Messages and Contacts.",
      {
        message: z.string().describe('Message body. Use \\r\\n for a new line.'),
        contacts: z
          .array(z.string())
          .min(1)
          .describe(
            'Recipient numbers, e.g. ["+61400000000"]. Up to 1000. Accepts +61.../61.../04.../4... formats.'
          ),
        sender: z
          .string()
          .optional()
          .describe("Optional sender ID or dedicated number. Blank = shared number."),
        scheduleAt: z
          .string()
          .optional()
          .describe("Optional UTC schedule time YYYY-MM-DDTHH:mm:ssZ. Blank = send now."),
      },
      async ({ message, contacts, sender, scheduleAt }) => {
        const body: Record<string, unknown> = { message, contacts };
        if (sender) body.sender = sender;
        if (scheduleAt) body.scheduleAt = scheduleAt;

        const result = (await cellcast("POST", "/gateway", body)) as any;

        // Log an outbound event per accepted recipient (skip when scheduled in the future).
        const queue = result?.data?.queueResponse;
        const warnings: string[] = [];
        if (Array.isArray(queue)) {
          for (const q of queue) {
            try {
              await ingestEvent({
                type: "sms.sent",
                direction: "outbound",
                source: "mcp-send",
                messageId: q?.MessageId ? String(q.MessageId) : undefined,
                from: sender,
                to: q?.Number || q?.Contact,
                body: message,
                status: "sent",
                raw: q,
              });
            } catch (e) {
              warnings.push((e as Error).message);
            }
          }
        }

        return asText(warnings.length ? { ...result, _eventWarnings: warnings } : result);
      }
    );

    server.tool(
      "get_responses",
      "List inbound SMS responses (replies) from Cellcast, paginated.",
      {
        page: z.number().int().min(1).optional().describe("Page number, default 1."),
      },
      async ({ page }) =>
        asText(await cellcast("GET", `/apiClient/getResponses?page=${page ?? 1}`))
    );

    server.tool(
      "rebuild_projections",
      "Replay the entire Events log to regenerate the Inbound, Outbound, and Contacts tables. Idempotent.",
      {},
      async () => asText(await rebuildProjections())
    );

    server.tool(
      "cellcast_request",
      "Advanced escape hatch: call any Cellcast API endpoint directly (templates, MMS, sent messages, opt-outs, etc.). Does not log events.",
      {
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
        path: z
          .string()
          .describe("Path after /api/v1, e.g. /apiClient/account"),
        body: z.record(z.any()).optional().describe("Optional JSON body."),
      },
      async ({ method, path, body }) => asText(await cellcast(method, path, body))
    );
  },
  {},
  { basePath: "/api" }
);

// Optional shared-secret guard. If MCP_SECRET is set, callers must supply it
// as ?key=... in the connector URL or an x-mcp-secret header.
function guard(req: Request): Response | null {
  const secret = process.env.MCP_SECRET;
  if (!secret) return null;
  const url = new URL(req.url);
  const provided = url.searchParams.get("key") || req.headers.get("x-mcp-secret");
  if (provided !== secret) return new Response("Unauthorized", { status: 401 });
  return null;
}

export async function GET(req: Request) {
  return guard(req) ?? handler(req);
}
export async function POST(req: Request) {
  return guard(req) ?? handler(req);
}
export async function DELETE(req: Request) {
  return guard(req) ?? handler(req);
}
