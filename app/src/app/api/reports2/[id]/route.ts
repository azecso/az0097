import { secured } from "@/lib/http";
import { badRequest, notFound } from "@/lib/errors";
import { reportById, REPORTS } from "@/lib/services/reports2";

const F = ["from", "to", "asOf", "partyId", "account", "productId", "currency", "locationId", "side"] as const;
export const filtersOf = (u: URLSearchParams) => Object.fromEntries(F.map((k) => [k, u.get(k) || undefined]).filter(([, v]) => v)) as Record<string, string>;
export const GET = secured({ perm: ["report", "view"] }, async ({ tx, req, params }) => {
  if (params.id === "_list") return REPORTS.map((r) => ({ id: r.id, title: r.title, basis: r.basis, definition: r.definition, filters: r.filters }));
  const def = reportById(params.id!); if (!def) throw notFound();
  const f = filtersOf(new URL(req.url).searchParams);
  for (const k of Object.keys(f)) if (!def.filters.includes(k as never)) throw badRequest("UNKNOWN_FILTER", k);
  return { id: def.id, title: def.title, basis: def.basis, definition: def.definition, filters: f, filterKeys: def.filters, ...(await def.run(tx, f)) };
});
