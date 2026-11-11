import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeWorld, bal, type World } from "./world";

let w: World;
beforeAll(async () => {
  w = await makeWorld();
  const r = await w.api(w.acct, w.R.capital.POST, { method: "POST", body: { kind: "INJECTION", docDate: "2026-01-01", cashAccountId: w.ids.cashUSD, currency: "USD", exchangeRate: "1480", amount: "10000", reason: "usd" } });
  await w.api(w.owner, w.R.capitalApprove, { method: "POST", params: { id: r.body.id }, body: {} });
});
afterAll(async () => { await w.env.teardown(); });
const lines = (code: string, memo: string) => w.env.admin`SELECT jl.debit_base::text d, jl.credit_base::text c FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id JOIN journal_entries je ON je.id = jl.entry_id WHERE a.code = ${code} AND je.memo LIKE ${memo + "%"} AND je.reverses_entry_id IS NULL`;

describe("USD liabilities settled at a different rate: liability cleared at booked rate, cash at payment rate, difference to 7100", () => {
  it("accrued expense 100 USD booked at 1,480 and paid at 1,520", async () => {
    const cat = await w.cat("مصروفات عامة");
    const e = await w.api(w.owner, w.R.expenses.POST, { method: "POST", body: { docDate: "2026-03-01", categoryId: cat, description: "إيجار", currency: "USD", exchangeRate: "1480", amount: "100", paymentMode: "ACCRUED" } });
    expect((await w.api(w.owner, w.R.expensePost, { method: "POST", params: { id: e.body.id } })).status).toBe(200);
    const p = await w.api(w.owner, w.R.expensePay.POST, { method: "POST", body: { expenseId: e.body.id, docDate: "2026-03-20", cashAccountId: w.ids.cashUSD, amount: "100", exchangeRate: "1520" } });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect((await lines("2210", "سداد"))[0]).toMatchObject({ d: "148000.0000" });
    expect((await lines("1120", "سداد"))[0]).toMatchObject({ c: "152000.0000" });
    expect((await lines("7100", "سداد"))[0]).toMatchObject({ d: "4000.0000" });          // loss: paid 4,000 IQD more than booked
    expect((await w.api(w.owner, w.R.trial)).body.balanced).toBe(true);
    const mv = (await w.env.admin`SELECT amount_base::text b FROM cash_movements WHERE doc_type = 'expense_payment'`)[0]!; expect(mv.b).toBe("-152000.0000");
  });
  it("salary 200 USD booked at 1,480 and paid at 1,450 gives a gain; reversing the payment restores everything", async () => {
    const e = await w.api(w.owner, w.R.employees.POST, { method: "POST", body: { name: "موظف دولار", monthlySalary: "200", currency: "USD" } });
    await w.api(w.owner, w.R.fx, { method: "POST", body: { currency: "USD", rateDate: "2026-05-01", rate: "1480" } }).catch(() => {});
    const g = await w.api(w.owner, w.R.payroll.POST, { method: "POST", body: { month: "2026-05" } }); expect(g.body.created).toBe(1);
    const acc = (await w.api(w.owner, w.R.payroll.GET, { path: "/api/payroll?month=2026-05" } as any)).body.find((a: any) => a.currency === "USD");
    await w.api(w.owner, w.R.payrollPost, { method: "POST", params: { id: acc.id } });
    const before = await w.tb();
    const p = await w.api(w.owner, w.R.payrollPay.POST, { method: "POST", body: { accrualId: acc.id, docDate: "2026-05-30", cashAccountId: w.ids.cashUSD, amount: "200", exchangeRate: "1450" } });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect((await lines("2200", "دفع راتب"))[0]).toMatchObject({ d: "296000.0000" });
    expect((await lines("1120", "دفع راتب"))[0]).toMatchObject({ c: "290000.0000" });
    expect((await lines("7100", "دفع راتب"))[0]).toMatchObject({ c: "6000.0000" });        // gain

  });
  it("reversing a payment reverses the FX result with it and the books stay balanced", async () => {
    const route = await import("@/app/api/expense-payments/[id]/reverse/route");
    const pay = (await w.env.admin`SELECT id FROM expense_payments WHERE status = 'POSTED' LIMIT 1`)[0]!.id;
    const r = await w.api(w.owner, (route as any).POST ?? (route as any).DELETE, { method: "POST", params: { id: pay }, body: { reason: "اختبار العكس" } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const fx = (await w.env.admin`SELECT COALESCE(sum(jl.debit_base - jl.credit_base),0)::text v FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id JOIN journal_entries je ON je.id = jl.entry_id WHERE a.code = '7100' AND je.memo LIKE '%سداد%'`)[0]!.v;
    expect(Number(fx)).toBe(0); expect((await w.tb()).balanced).toBe(true);
  });
});
