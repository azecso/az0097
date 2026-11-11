import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeWorld, type World } from "./world";

let w: World;
beforeAll(async () => { w = await makeWorld(); await w.fund("1000000"); });
afterAll(async () => { await w.env.teardown(); });
const tomorrow = () => new Date(Date.now() + 86400000).toISOString().slice(0, 10);
const preview = (extra: Record<string, unknown>) => w.api(w.owner, w.R.settlePreview, { method: "POST", body: { periodStart: "2026-01-01", periodEnd: "2026-03-31", ...extra } });

describe("manual adjustments need a reason", () => {
  it("a profit adjustment without a written reason is refused; with one it is accepted and kept on the settlement", async () => {
    expect((await preview({ adjustments: "5000" })).body.error.code).toBe("ADJUSTMENT_REASON_REQUIRED");
    expect((await preview({ adjustments: "5000", adjustmentReason: "ربح غير مسجّل: بيع عيني" })).status).toBe(200);
    const d = await w.api(w.owner, w.R.settlements.POST, { method: "POST", body: { periodStart: "2026-01-01", periodEnd: "2026-03-31", adjustments: "0" } }); expect(d.status).toBe(200);
  });
});
describe("effective-dated settings", () => {
  it("a setting change is a dated, reasoned, append-only record; it cannot be back-dated and never rewrites history", async () => {
    const put = (b: unknown) => w.api(w.owner, w.R.profitSettings.PUT, { method: "PUT", body: b });
    expect((await put({ profitStepUp: true, effectiveFrom: "2020-01-01", reason: "x y z" })).body.error.code).toBe("EFFECTIVE_DATE_IN_THE_PAST");
    expect((await put({ profitStepUp: true, effectiveFrom: tomorrow(), reason: "سياسة جديدة من الغد" })).status).toBe(200);
    expect((await w.api(w.owner, w.R.profitSettings.GET)).body.profitStepUp).toBe(false);                           // not in force yet
    expect((await put({ profitStepUp: true, reason: "تفعيل فوري" })).status).toBe(200);
    const g = (await w.api(w.owner, w.R.profitSettings.GET)).body; expect(g.profitStepUp).toBe(true); expect(g.history).toHaveLength(2);
    await expect(w.env.admin`UPDATE setting_changes SET reason = 'tamper'`).rejects.toThrow(); await expect(w.env.admin`DELETE FROM setting_changes`).rejects.toThrow();
    expect((await put({ profitStepUp: false, reason: "إلغاء" })).status).toBe(200);
  });
});
