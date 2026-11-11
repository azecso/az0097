/** Shared by the report screen and its print page: ONE formatting rule (IQD no decimals, USD two, quantities trimmed, percentages as %). Values stay exact decimal strings. */
export interface RCol { key: string; label: string; kind?: "text" | "money" | "qty" | "pct"; href?: string; cur?: string }
export interface RResult { id: string; title: string; basis: string; definition: string; filters: Record<string, string>; filterKeys: string[]; columns: RCol[]; rows: Record<string, string | null>[]; totals: Record<string, string | null>[]; notes: string[] }
const group = (i: string) => i.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
function fixed(v: string, places: number) {                         // exact string rounding (half up) — no JS Number involved
  const neg = v.startsWith("-"); const [i = "0", f = ""] = (neg ? v.slice(1) : v).split(".");
  const digits = (i + f.padEnd(places, "0").slice(0, places)); let r = digits; const next = f.charAt(places);
  if (next && next >= "5") { r = (BigInt(digits) + 1n).toString().padStart(digits.length, "0"); }
  const ip = r.slice(0, r.length - places) || "0", fp = places ? r.slice(r.length - places) : "";
  return (neg && /[1-9]/.test(r) ? "-" : "") + group(ip) + (places ? "." + fp : "");
}
export function fmtCell(row: Record<string, string | null>, c: RCol): string {
  const v = row[c.key]; if (v === null || v === undefined || v === "") return "";
  if (c.kind === "money") return fixed(v, (c.cur ?? row.currency) === "USD" ? 2 : 0);
  if (c.kind === "qty") { const [i = "0", f = ""] = v.split("."); const t = f.replace(/0+$/, ""); return group(i.replace(/^-0$/, "0")) + (t ? "." + t : ""); }
  if (c.kind === "pct") return fixed(v, 2) + "%";
  return v;
}
