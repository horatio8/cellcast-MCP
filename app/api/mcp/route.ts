import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { cellcast } from "../../../lib/cellcast";
import { listAccounts, MAIN_ACCOUNT } from "../../../lib/accounts";
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

// Every Cellcast tool takes this. Leaving it out uses the main account.
const account = z
  .string()
  .optional()
  .describe(
    `Which client's Cellcast account to use, e.g. "Defend Sacred Ground". Omit (or "${MAIN_ACCOUNT}") for the main account. Call list_accounts to see the names.`
  );
const accountOnly = z.object({ account });

// Cellcast returns API keys in some responses (token verify, the sub-account
// token list). Strip them before anything reaches the client.
function redactKeys(data: any): any {
  if (Array.isArray(data)) return data.map(redactKeys);
  if (data && typeof data === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      out[k] = k === "token" && typeof v === "string" ? "[redacted]" : redactKeys(v);
    }
    return out;
  }
  return data;
}

// Clients that loaded the tool list before `account` existed cannot send that
// argument. For them, cellcast_request also accepts the account as an
// `account` query parameter on the path, or an `account` key in the body.
// Both are removed before the request goes to Cellcast.
function pickLegacyAccount(
  path: string,
  body: Record<string, unknown> | undefined
): { path: string; body: Record<string, unknown> | undefined; account?: string } {
  let account: string | undefined;
  let outPath = path;
  const q = path.indexOf("?");
  if (q !== -1) {
    const params = new URLSearchParams(path.slice(q + 1));
    const fromQuery = params.get("account");
    if (fromQuery) {
      account = fromQuery;
      params.delete("account");
      const rest = params.toString();
      outPath = path.slice(0, q) + (rest ? `?${rest}` : "");
    }
  }
  let outBody = body;
  if (body && typeof body.account === "string") {
    account = account || (body.account as string);
    const { account: _drop, ...rest } = body;
    outBody = Object.keys(rest).length ? rest : undefined;
  }
  return { path: outPath, body: outBody, account };
}

// Errors from account lookup come back as a normal tool error, not a crash.
async function withAccount(fn: () => Promise<unknown>) {
  try {
    return asResult(redactKeys(await fn()));
  } catch (e) {
    return {
      content: [{ type: "text" as const, text: (e as Error).message }],
      isError: true,
    };
  }
}

const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      "list_accounts",
      {
        title: "List client accounts",
        description:
          "List the Cellcast accounts this connector can use: the main account plus each client sub-account. Pass a name as `account` to the other tools.",
        inputSchema: z.object({}),
        outputSchema: jsonObject,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async () => withAccount(async () => ({ accounts: await listAccounts() }))
    );

    server.registerTool(
      "verify_token",
      {
        title: "Verify Cellcast token",
        description: "Verify that the Cellcast API token for an account is valid.",
        inputSchema: accountOnly,
        outputSchema: jsonObject,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      // Cellcast echoes the API key back in data.token; withAccount redacts it.
      async ({ account }) => withAccount(() => cellcast("GET", "/user/token/verify", undefined, account))
    );

    server.registerTool(
      "get_balance",
      {
        title: "Get account balance",
        description: "Get the SMS and MMS balance of the main account or a client sub-account.",
        inputSchema: accountOnly,
        outputSchema: jsonObject,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ account }) => withAccount(() => cellcast("GET", "/apiClient/account", undefined, account))
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
          account,
        }),
        outputSchema: jsonObject,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      },
      async ({ message, contacts, sender, scheduleAt, account }) => {
        const body: Record<string, unknown> = { message, contacts };
        if (sender) body.sender = sender;
        if (scheduleAt) body.scheduleAt = scheduleAt;

        let result: any;
        try {
          result = await cellcast("POST", "/gateway", body, account);
        } catch (e) {
          return { content: [{ type: "text" as const, text: (e as Error).message }], isError: true };
        }

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
                raw: account ? { ...q, account } : q,
              });
            } catch (e) {
              warnings.push((e as Error).message);
            }
          }
        }

        const out = warnings.length ? { ...result, _eventWarnings: warnings } : result;
        return asResult(redactKeys(out));
      }
    );

    server.registerTool(
      "get_responses",
      {
        title: "List inbound replies",
        description:
          "List inbound SMS responses (replies) for the main account or a client sub-account, paginated.",
        inputSchema: z.object({
          page: z.number().int().min(1).optional().describe("Page number, default 1."),
          account,
        }),
        outputSchema: jsonObject,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ page, account }) =>
        withAccount(() => cellcast("GET", `/apiClient/getResponses?page=${page ?? 1}`, undefined, account))
    );

    server.registerTool(
      "rebuild_projections",
      {
        title: "Rebuild projections",
        description:
          "Replay the entire Events log to regenerate the Inbound, Outbound, and Contacts tables. Idempotent.",
        inputSchema: z.object({}),
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
          "Advanced escape hatch: call any Cellcast API endpoint directly (templates, MMS, sent messages, opt-outs, etc.). Can send messages or change account data depending on the method and path. Does not log events. To act as a client sub-account, pass `account`, or add account=<client name> to the path's query string, or put \"account\" in the body.",
        inputSchema: z.object({
          method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
          path: z.string().describe("Path after /api/v1, e.g. /apiClient/account"),
          body: z.looseObject({}).optional().describe("Optional JSON body."),
          account,
        }),
        outputSchema: jsonObject,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      },
      async ({ method, path, body, account }) => {
        const picked = pickLegacyAccount(path, body);
        return withAccount(() =>
          cellcast(method, picked.path, picked.body, account || picked.account)
        );
      }
    );
  },
  {
    serverInfo: { name: "cellcast", version: "2.0.0" },
    instructions:
      "Cellcast SMS for an Australian account with one sub-account per client. Each tool takes an optional `account` naming the client (see list_accounts); leave it out for the main account. send_sms and cellcast_request send real messages and spend credit, so confirm the account, recipients and wording with the user first. Use get_responses to read replies and get_balance to check credit.",
  }
);

// Access is controlled by a shared token set in the environment. See lib/mcpAuth.ts.
async function route(req: Request): Promise<Response> {
  return requireToken(req) ?? handler(req);
}

export { route as GET, route as POST, route as DELETE };
