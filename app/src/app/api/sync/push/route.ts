import { NextRequest } from "next/server";
import { authenticate, clientIp, fail, json } from "@/lib/http";
import { pushOperations, pushSchema } from "@/lib/services/sync";

export async function POST(req: NextRequest) {
  try {
    const who = await authenticate(req);
    const body = pushSchema.parse(await req.json());
    return json({ results: await pushOperations(who, clientIp(req), body), serverTime: new Date().toISOString() });
  } catch (e) { return fail(e); }
}
