import { secured } from "@/lib/http";
import { referenceSnapshot } from "@/lib/services/sync";
export const GET = secured({}, ({ tx }) => referenceSnapshot(tx));
