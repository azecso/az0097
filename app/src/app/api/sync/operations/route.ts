import { secured } from "@/lib/http";
import { listOperations } from "@/lib/services/sync";
export const GET = secured({}, ({ tx, principal, req }) => listOperations(tx, principal.userId, new URL(req.url).searchParams.get("deviceId") ?? undefined));
