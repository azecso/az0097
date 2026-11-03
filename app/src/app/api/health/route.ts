import { sql } from "@/lib/db";
export async function GET() {
  try { await sql`SELECT 1`; return Response.json({ ok: true }); } catch { return Response.json({ ok: false }, { status: 503 }); }
}
