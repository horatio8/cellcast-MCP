// Client sub-accounts.
//
// Each client gets a Cellcast sub-account with its own API key, so its inbox,
// sends and balance stay separate. Every MCP tool takes an optional `account`
// argument naming the client; leaving it out uses the main account
// (CELLCAST_API_KEY).
//
// A key for an account name is found in this order:
//   1. CELLCAST_ACCOUNTS, a JSON object mapping a short name to that client's
//      API key, e.g. {"dsg":"eyJ...","fairmigration":"eyJ..."}
//   2. The main account's list of sub-account API tokens (GET /apiClient/token),
//      matched against the token name, the sub-account name or its company
//      name. This lets a new client work as soon as a token exists in
//      Cellcast, without a redeploy.
//
// Names are compared ignoring case, spaces and punctuation, so
// "Defend Sacred Ground", "defend-sacred-ground" and "DefendSacredGround" all
// match. Keys are never returned to MCP clients.

const BASE_URL = "https://api.cellcast.com/api/v1";

export const MAIN_ACCOUNT = "main";

export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function mainKey(): string {
  const key = process.env.CELLCAST_API_KEY;
  if (!key) throw new Error("CELLCAST_API_KEY environment variable is not set.");
  return key;
}

function configuredAccounts(): Map<string, { name: string; key: string }> {
  const out = new Map<string, { name: string; key: string }>();
  const raw = process.env.CELLCAST_ACCOUNTS;
  if (!raw) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("CELLCAST_ACCOUNTS is not valid JSON. Expected {\"name\":\"api key\", ...}.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("CELLCAST_ACCOUNTS must be a JSON object of {\"name\":\"api key\"}.");
  }
  for (const [name, key] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof key === "string" && key.trim()) {
      out.set(normalizeName(name), { name, key: key.trim() });
    }
  }
  return out;
}

// The main key is a JWT whose payload carries the owner's userId. Tokens the
// main account issued for itself show up in the token list too; skip those.
function mainUserId(): string | undefined {
  try {
    const payload = mainKey().split(".")[1];
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return json?.userId ? String(json.userId) : undefined;
  } catch {
    return undefined;
  }
}

export interface SubAccountToken {
  tokenName: string;
  status: string;
  subAccountId: string;
  subAccountName: string;
  companyName: string;
  key: string;
}

// Sub-account tokens visible to the main key. Cached briefly per instance.
let tokenCache: { at: number; items: SubAccountToken[] } | null = null;
const CACHE_MS = 60_000;

export async function listSubAccountTokens(force = false): Promise<SubAccountToken[]> {
  if (!force && tokenCache && Date.now() - tokenCache.at < CACHE_MS) return tokenCache.items;

  const items: SubAccountToken[] = [];
  const selfId = mainUserId();
  for (let page = 1; page <= 20; page++) {
    const res = await fetch(`${BASE_URL}/apiClient/token?page=${page}&limit=50`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${mainKey()}` },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Could not list sub-account tokens (HTTP ${res.status}).`);
    const json = (await res.json()) as any;
    const pageItems: any[] = Array.isArray(json?.data?.items) ? json.data.items : [];
    for (const t of pageItems) {
      if (selfId && String(t?.subAccount?._id ?? "") === selfId) continue;
      items.push({
        tokenName: String(t?.name ?? ""),
        status: String(t?.status ?? ""),
        subAccountId: String(t?.subAccount?._id ?? ""),
        subAccountName: String(t?.subAccount?.name ?? ""),
        companyName: String(t?.subAccount?.companyName ?? ""),
        key: String(t?.token ?? ""),
      });
    }
    if (!json?.data?.hasNextPage) break;
  }
  tokenCache = { at: Date.now(), items };
  return items;
}

// Returns the API key to use for an account name. Throws a readable error
// listing the known accounts when the name does not match.
export async function resolveApiKey(account?: string): Promise<string> {
  if (!account || normalizeName(account) === MAIN_ACCOUNT) return mainKey();
  const wanted = normalizeName(account);
  if (!wanted) return mainKey();

  const configured = configuredAccounts().get(wanted);
  if (configured) return configured.key;

  const tokens = (await listSubAccountTokens()).filter((t) => t.status === "active" && t.key);
  const match =
    tokens.find((t) => normalizeName(t.tokenName) === wanted) ||
    tokens.find((t) => normalizeName(t.subAccountName) === wanted) ||
    tokens.find((t) => normalizeName(t.companyName) === wanted) ||
    tokens.find((t) => t.subAccountId === account);
  if (match) return match.key;

  const known = (await listAccounts()).map((a) => a.name).join(", ");
  throw new Error(`Unknown Cellcast account "${account}". Known accounts: ${known}.`);
}

export interface AccountInfo {
  name: string;
  source: "main" | "configured" | "sub-account";
  subAccountId?: string;
  subAccountName?: string;
  companyName?: string;
  tokenName?: string;
}

// Accounts a caller can name, without any keys.
export async function listAccounts(): Promise<AccountInfo[]> {
  const out: AccountInfo[] = [{ name: MAIN_ACCOUNT, source: "main" }];
  for (const { name } of configuredAccounts().values()) {
    out.push({ name, source: "configured" });
  }
  let tokens: SubAccountToken[] = [];
  try {
    tokens = await listSubAccountTokens();
  } catch {
    // Discovery is optional; configured accounts still work without it.
  }
  const configuredNames = new Set(configuredAccounts().keys());
  const seen = new Set<string>();
  for (const t of tokens) {
    if (t.status !== "active" || seen.has(t.subAccountId)) continue;
    seen.add(t.subAccountId);
    if (configuredNames.has(normalizeName(t.tokenName)) || configuredNames.has(normalizeName(t.subAccountName))) {
      continue;
    }
    out.push({
      name: t.subAccountName || t.tokenName,
      source: "sub-account",
      subAccountId: t.subAccountId,
      subAccountName: t.subAccountName,
      companyName: t.companyName,
      tokenName: t.tokenName,
    });
  }
  return out;
}
