import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { authenticate, fail } from "@/lib/http";
import { withTenant } from "@/lib/db";
import { require_ } from "@/lib/authz";
import { notFound } from "@/lib/errors";
import { addSheet } from "@/lib/services/exports";
import { reportById } from "@/lib/services/reports2";
import { filtersOf } from "../../reports2/[id]/route";

/** Excel of EXACTLY what the screen shows: same definition, same filters, same rows and totals (see reports2.ts). */
export async function GET(req: NextRequest, c: { params: Promise<{ id: string }> }) {
  try {
    const who = await authenticate(req); const { id } = await c.params; const def = reportById(id); if (!def) throw notFound();
    const f = filtersOf(new URL(req.url).searchParams);
    const r = await withTenant(who.companyId, async (tx) => { await require_(tx, who, "report", "export"); return def.run(tx, f); });
    const wb = new ExcelJS.Workbook(); wb.creator = "النظام المحاسبي"; wb.created = new Date();
    const cols = r.columns.map((x) => ({ header: x.label, key: x.key, kind: x.kind === "pct" ? ("pct" as const) : x.kind, width: x.kind ? 16 : 28 }));
    const hasCur = r.rows.some((x) => x.currency);
    const ws = addSheet(wb, def.title, hasCur && !cols.some((x) => x.key === "currency") ? [...cols.slice(0, 1), { header: "العملة", key: "currency", kind: "text" as const, width: 10 }, ...cols.slice(1)] : cols, [...r.rows] as never, undefined, r.totals as never);
    ws.addRow([]); ws.addRow([`${def.title} — ${def.definition}`]); for (const n of r.notes) ws.addRow([n]); ws.addRow([`الفلاتر: ${Object.entries(f).map(([k, v]) => `${k}=${v}`).join(" ") || "—"}`]);
    return new NextResponse(new Uint8Array(Buffer.from(await wb.xlsx.writeBuffer())), { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="${def.id}-${new Date().toISOString().slice(0, 10)}.xlsx"`, "Cache-Control": "no-store" } });
  } catch (e) { return fail(e); }
}
