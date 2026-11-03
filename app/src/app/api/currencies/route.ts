import { secured } from "@/lib/http";
export const GET = secured({}, ({ tx }) => tx`SELECT code, name, decimals FROM currencies ORDER BY code`);
