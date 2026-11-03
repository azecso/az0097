import { secured, parse } from "@/lib/http";
import { addOpening, listOpening, openingEquation, openingSchema } from "@/lib/services/opening";
export const GET = secured({ perm: ["opening_balance", "view"] }, async ({ tx }) => ({ rows: await listOpening(tx), equation: await openingEquation(tx) }));
export const POST = secured({ perm: ["opening_balance", "create"] }, async ({ tx, principal, actor, req }) => addOpening(tx, principal, actor, parse(openingSchema, await req.json())));
