// Normalise Australian numbers to a canonical E.164-ish key so the same
// person is one Contact regardless of the format Cellcast sends.
// Accepts +61400000000, 61400000000, 0400000000, 400000000.

export function normalizePhone(raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  let s = String(raw).trim().replace(/[\s\-()]/g, "");
  if (!s) return "";

  if (s.startsWith("+")) return s;
  if (s.startsWith("61")) return `+${s}`;
  if (s.startsWith("0")) return `+61${s.slice(1)}`;
  // 9-digit mobile without leading 0 (e.g. 400000000)
  if (/^\d{9}$/.test(s)) return `+61${s}`;
  // Fallback: assume already international without the plus.
  return `+${s}`;
}
