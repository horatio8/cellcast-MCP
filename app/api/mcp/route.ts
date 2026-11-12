import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { cellcast } from "../../../lib/cellcast";
import { requireToken } from "../../../lib/mcpAuth";
import { ingestEvent, rebuildProjections } from "../../../lib/store";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

// Every tool returns the upstream JSON twice: as structuredContent for clients
// that read it, and as the same JSON in a text block for clients that do not.
// Upstream HTTP failures are flagged with isError so the model can react.
function asResult(data: unknown) {
  const structuredContent: Record<string, unknown> =
    data !== null && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : { result: data };
  const failed = structuredContent.ok === false && "httpStatus" in structuredContent;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent,
    ...(failed ? { isError: true } : {}),
  };
}

// Responses are passed through from Cellcast, so the shape is an open object.
const jsonObject = z.looseObject({});
const noInput = z.object({});

const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      "verify_token",
      {
        title: "Verify Cellcast token",
        description: "Verify that the configured Cellcast API token is valid.",
        inputSchema: noInput,
        outputSchema: jsonObject,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async () => {
        // Cellcast echoes the API key back in data.token. Never pass it to the client.
        const result = (await cellcast("GET", "/user/token/verify")) as any;
        if (result?.data && typeof result.data === "object" && "token" in result.data) {
          result.data = { ...result.data, token: "[redacted]" };
        }
        return asResult(result);
      }
    );

    server.registerTool(
      "get_balance",
      {
        title: "Get account balance",
        description: "Get the Cellcast account's SMS and MMS balance.",
        inputSchema: noInput,
        outputSchema: jsonObject,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async () => asResult(await cellcast("GET", "/apiClient/account"))
    );

    server.registerTool(
      "send_sms",
      {
        title: "Send SMS",
        description:
          "Send an SMS to one or more recipients via Cellcast. This sends real messages and uses account credit. Each accepted recipient is logged as an outbound event and projected into Outbound Messages and Contacts.",
        inputSchema: z.object({
          message: z.string().describe("Message body. Use \\r\\n for a new line."),
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
        }),
        outputSchema: jsonObject,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
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

        return asResult(warnings.length ? { ...result, _eventWarnings: warnings } : result);
      }
    );

    server.registerTool(
      "get_responses",
      {
        title: "List inbound replies",
        description: "List inbound SMS responses (replies) from Cellcast, paginated.",
        inputSchema: z.object({
          page: z.number().int().min(1).optional().describe("Page number, default 1."),
        }),
        outputSchema: jsonObject,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ page }) =>
        asResult(await cellcast("GET", `/apiClient/getResponses?page=${page ?? 1}`))
    );

    server.registerTool(
      "rebuild_projections",
      {
        title: "Rebuild projections",
        description:
          "Replay the entire Events log to regenerate the Inbound, Outbound, and Contacts tables. Idempotent.",
        inputSchema: noInput,
        outputSchema: jsonObject,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async () => asResult(await rebuildProjections())
    );

    server.registerTool(
      "cellcast_request",
      {
        title: "Raw Cellcast API request",
        description:
          "Advanced escape hatch: call any Cellcast API endpoint directly (templates, MMS, sent messages, opt-outs, etc.). Can send messages or change account data depending on the method and path. Does not log events.",
        inputSchema: z.object({
          method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
          path: z.string().describe("Path after /api/v1, e.g. /apiClient/account"),
          body: z.looseObject({}).optional().describe("Optional JSON body."),
        }),
        outputSchema: jsonObject,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      },
      async ({ method, path, body }) => asResult(await cellcast(method, path, body))
    );
  },
  {
    serverInfo: { name: "cellcast", version: "2.0.0" },
    instructions:
      "Cellcast SMS for an Australian account. send_sms and cellcast_request send real messages and spend credit, so confirm recipients and wording with the user first. Use get_responses to read replies and get_balance to check credit.",
  }
);

// Access is controlled by a shared token set in the environment. See lib/mcpAuth.ts.
async function route(req: Request): Promise<Response> {
  return requireToken(req) ?? handler(req);
}

export { route as GET, route as POST, route as DELETE };
