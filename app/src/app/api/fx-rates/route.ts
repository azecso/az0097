import { secured, parse } from "@/lib/http";
import { fxSchema, listRates, upsertRate } from "@/lib/services/fx";

export const GET = secured({ perm: ["fx_rate", "view"] }, ({ tx, req }) => listRates(tx, new URL(req.url).searchParams.get("currency") ?? undefined));
export const POST = secured({ perm: ["fx_rate", "create"] }, async ({ tx, principal, actor, req }) =>
  upsertRate(tx, principal, actor, parse(fxSchema, await req.json())));
