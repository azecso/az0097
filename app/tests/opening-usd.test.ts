import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeWorld, bal, type World } from "./world";

let w: World;
beforeAll(async () => { w = await makeWorld(); });
afterAll(async () => { await w.env.teardown(); });
const add = (b: Record<string, unknown>) => w.api(w.owner, w.R.opening.POST, { method: "POST", body: { asOf: "2026-01-01", ...b } });

describe("opening USD cash keeps original amount, rate and IQD equivalent", () => {
  it("a USD cash opening requires a rate and books 100 USD at 1,480 as 148,000 IQD (never 100 IQD)", async () => {
    expect((await add({ kind: "CASH", cashAccountId: w.ids.cashUSD, amount: "100" })).body.error.code).toBe("FX_RATE_REQUIRED");
    expect((await add({ kind: "CASH", cashAccountId: w.ids.cashUSD, amount: "100", fxRate: "1480" })).status).toBe(200);
    await add({ kind: "CASH", cashAccountId: w.ids.cashIQD, amount: "500000", fxRate: "1480" });   // IQD account ignores a supplied rate
    await add({ kind: "CAPITAL", amount: "648000" });
    const eq = (await w.api(w.owner, w.R.opening.GET)).body.equation;
    expect(eq.cash).toBe("648000"); expect(eq.difference).toBe("0");
    const p = await w.api(w.owner, w.R.openingPost, { method: "POST" }); expect(p.status).toBe(200);
    const l = (await w.env.admin`SELECT jl.debit_base::text d, jl.currency, jl.amount_orig::text o, jl.fx_rate_snapshot::text fx FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id WHERE a.code = '1120'`)[0]!;
    expect(l).toMatchObject({ d: "148000.0000", currency: "USD", o: "100.0000", fx: "1480.00000000" });
    const cash = (await w.api(w.owner, w.R.cash)).body.find((c: any) => c.currency === "USD");
    expect(Number(cash.balance)).toBe(100);
    expect(bal(await w.tb(), "1120")).toBe(148000);
  });
});
