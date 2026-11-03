import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeWorld, bal, expectFail, type World } from "./world";

let w: World;
beforeAll(async () => { w = await makeWorld(); await w.fund("10000000"); });
afterAll(async () => { await w.env.teardown(); });

const exp = (body: Record<string, unknown>, s = w.owner) => w.api(s, w.R.expenses.POST, { method: "POST", body: { docDate: "2026-03-01", currency: "IQD", description: "اختبار", ...body } });
const postExp = (id: string, s = w.owner) => w.api(s, w.R.expensePost, { method: "POST", params: { id } });
const D = async (code: string) => bal(await w.tb(), code);

describe("capital: request by the accountant, approval by the owner only (TC-10)", () => {
  it("the funded capital appears in 3100 and in cash; a posted request is numbered", async () => {
    const tb = await w.tb(); expect(-bal(tb, "3100")).toBe(10000000); expect(bal(tb, "1110")).toBe(10000000);
    const list = (await w.api(w.owner, w.R.capital.GET)).body;
    expect(list.balance).toBe("10000000"); expect(list.transactions[0].docNo).toMatch(/^CP-2026-/); expect(list.transactions[0].status).toBe("POSTED");
  });
  it("accountant creates a withdrawal REQUEST but can never approve it; the database refuses it too", async () => {
    const r = await w.api(w.acct, w.R.capital.POST, { method: "POST", body: { kind: "WITHDRAWAL", docDate: "2026-03-02", cashAccountId: w.ids.cashIQD, currency: "IQD", amount: "1000000", reason: "حاجة شخصية للمالك" } });
    expect(r.status).toBe(200); expect(r.body.status).toBe("REQUESTED");
    const a = await w.api(w.acct, w.R.capitalApprove, { method: "POST", params: { id: r.body.id }, body: {} });
    expect(a.status).toBe(403);
    const acctId = (await w.env.admin`SELECT id FROM users WHERE username = 'acc'`)[0]!.id;
    await expectFail(w.inject((tx) => tx`UPDATE capital_transactions SET status = 'POSTED', doc_no = 'X-2', approved_by = ${acctId} WHERE id = ${r.body.id}`), /CAPITAL_APPROVAL_OWNER_ONLY/);
    const before = await w.tb();
    const ok = await w.api(w.owner, w.R.capitalApprove, { method: "POST", params: { id: r.body.id }, body: {} });
    expect(ok.status).toBe(200);
    const tb = await w.tb();
    expect(bal(tb, "3100") - bal(before, "3100")).toBe(1000000); expect(bal(tb, "1110") - bal(before, "1110")).toBe(-1000000);       // Dr capital / Cr cash, no income, no expense
    expect(tb.rows.filter((x: any) => x.type === "EXPENSE").length).toBe(0);
  });
  it("withdrawals cannot exceed cash or the capital on the books; requests can be rejected", async () => {
    const big = await w.api(w.owner, w.R.capital.POST, { method: "POST", body: { kind: "WITHDRAWAL", docDate: "2026-03-03", cashAccountId: w.ids.cashIQD, currency: "IQD", amount: "99000000", reason: "اختبار تجاوز" } });
    expect((await w.api(w.owner, w.R.capitalApprove, { method: "POST", params: { id: big.body.id }, body: {} })).body.error.code).toBe("INSUFFICIENT_CASH");
    expect((await w.api(w.owner, w.R.capitalReject, { method: "POST", params: { id: big.body.id }, body: { reason: "غير مبرر" } })).status).toBe(200);
    expect((await w.api(w.owner, w.R.capitalApprove, { method: "POST", params: { id: big.body.id }, body: {} })).body.error.code).toBe("NOT_REQUESTED");
    await expectFail(w.inject((tx, a) => tx`INSERT INTO capital_transactions(company_id, draft_ref, doc_date, kind, partner_id, cash_account_id, currency, exchange_rate_snapshot, amount, reason, requested_by)
      SELECT ${a.companyId}, 'D-X', '2026-03-04', 'INJECTION', id, ${w.ids.cashIQD}, 'IQD', 1, 10, 'x', ${a.userId} FROM partners WHERE kind = 'PARTNER'`), /ONLY_OWNER_FUNDS_CAPITAL/);       // the partner can never fund capital
  });
  it("cash can never go negative, even with simultaneous outflows (row-locked)", async () => {
    const eid = async () => (await exp({ categoryId: await w.cat("مصروفات عامة"), amount: "6000000", paymentMode: "PAID_CASH", cashAccountId: w.ids.cashIQD })).body.id;
    const [a, b] = [await eid(), await eid()];
    const cash = Number((await w.api(w.owner, w.R.cash)).body.find((c: any) => c.id === w.ids.cashIQD).balance) || 0; void cash;
    const res = await Promise.all([a, b].map((id) => postExp(id)));
    expect(res.filter((r) => r.status === 200).length).toBe(1);
    expect(res.filter((r) => r.status === 409 && r.body.error.code === "INSUFFICIENT_CASH").length).toBe(1);
    expect(await D("1110")).toBeGreaterThanOrEqual(0);
  });
});

describe("TC-04 salary accrual vs payment", () => {
  it("accrued 400,000 unpaid = expense 400,000 + liability 400,000; paying later creates no second expense", async () => {
    const e = await w.api(w.owner, w.R.employees.POST, { method: "POST", body: { name: "موظف الاختبار", monthlySalary: "400000", currency: "IQD" } });
    const g = await w.api(w.owner, w.R.payroll.POST, { method: "POST", body: { month: "2026-04" } });
    expect(g.body.created).toBe(1);
    expect((await w.api(w.owner, w.R.payroll.POST, { method: "POST", body: { month: "2026-04" } })).body.created).toBe(0);          // never duplicated
    const acc = (await w.api(w.owner, w.R.payroll.GET, { query: undefined, path: "/api/payroll?month=2026-04" } as any)).body[0];
    const before = await w.tb();
    expect((await w.api(w.owner, w.R.payrollPost, { method: "POST", params: { id: acc.id } })).status).toBe(200);
    const mid = await w.tb();
    expect(bal(mid, "6200") - bal(before, "6200")).toBe(400000); expect(-bal(mid, "2200") - -bal(before, "2200")).toBe(400000);
    const pay = await w.api(w.owner, w.R.payrollPay.POST, { method: "POST", body: { accrualId: acc.id, docDate: "2026-04-28", cashAccountId: w.ids.cashIQD, amount: "150000" } });
    expect(pay.status).toBe(200); expect(pay.body.docNo).toMatch(/^PP-2026-/);
    const after = await w.tb();
    expect(bal(after, "6200")).toBe(bal(mid, "6200"));                                    // no new expense
    expect(-bal(after, "2200") - -bal(mid, "2200")).toBe(-150000);                        // liability reduced
    expect((await w.api(w.owner, w.R.payrollPay.POST, { method: "POST", body: { accrualId: acc.id, docDate: "2026-04-29", cashAccountId: w.ids.cashIQD, amount: "300000" } })).body.error.code).toBe("OVER_PAYMENT");
    expect((await w.api(w.owner, w.R.payrollPay.POST, { method: "POST", body: { accrualId: acc.id, docDate: "2026-04-29", cashAccountId: w.ids.cashIQD, amount: "250000" } })).status).toBe(200);
    expect(bal(await w.tb(), "2200")).toBe(0);
    expect((await w.api(w.owner, w.R.payrollReverse, { method: "POST", params: { id: acc.id }, body: { reason: "اختبار" } })).body.error.code).toBe("HAS_PAYMENTS");
    void e;
  });
});

describe("TC-05 expense paid by the partner out of pocket", () => {
  it("PAYABLE: expense + payable to the partner; settling reduces the payable and cash ONLY", async () => {
    const before = await w.tb();
    const x = await exp({ categoryId: await w.cat("صيانة"), amount: "50000", paymentMode: "PAID_BY_PARTNER", partnerTreatment: "PAYABLE_TO_PARTNER" });
    expect((await postExp(x.body.id)).status).toBe(200);
    const mid = await w.tb();
    expect(bal(mid, "6600") - bal(before, "6600")).toBe(50000); expect(-bal(mid, "2300") - -bal(before, "2300")).toBe(50000);
    const pay = await w.api(w.owner, w.R.expensePay.POST, { method: "POST", body: { expenseId: x.body.id, docDate: "2026-05-01", cashAccountId: w.ids.cashIQD, amount: "50000" } });
    expect(pay.status).toBe(200);
    const after = await w.tb();
    expect(bal(after, "6600")).toBe(bal(mid, "6600")); expect(-bal(after, "2300")).toBe(-bal(before, "2300"));      // payable cleared, expense unchanged
    expect(bal(after, "1110") - bal(mid, "1110")).toBe(-50000);
    expect((await w.api(w.owner, w.R.expensePay.POST, { method: "POST", body: { expenseId: x.body.id, docDate: "2026-05-02", cashAccountId: w.ids.cashIQD, amount: "1" } })).body.error.code).toBe("NOTHING_DUE");
  });
  it("one treatment only: a partner expense without a treatment, or a cash expense with one, is rejected (no double recording)", async () => {
    const cat = await w.cat("صيانة");
    expect((await exp({ categoryId: cat, amount: "1000", paymentMode: "PAID_BY_PARTNER" })).body.error.code).toBe("PARTNER_TREATMENT");
    expect((await exp({ categoryId: cat, amount: "1000", paymentMode: "PAID_CASH", cashAccountId: w.ids.cashIQD, partnerTreatment: "PAYABLE_TO_PARTNER" })).body.error.code).toBe("PARTNER_TREATMENT");
    expect((await exp({ categoryId: cat, amount: "1000", paymentMode: "PAID_BY_PARTNER", partnerTreatment: "OFFSET_AGAINST_ADVANCES" })).body.error.code).toBe("SETTLEMENT_NOTE_REQUIRED");
  });
  it("OFFSET: documented netting against the advances the partner already drew; refused when advances are insufficient", async () => {
    const cat = await w.cat("صيانة");
    const x = await exp({ categoryId: cat, amount: "50000", paymentMode: "PAID_BY_PARTNER", partnerTreatment: "OFFSET_AGAINST_ADVANCES", settlementNote: "يُسوّى مقابل سلفة الشريك الشهرية" });
    expect((await postExp(x.body.id)).body.error.code).toBe("INSUFFICIENT_PARTNER_ADVANCES");
    const adv = await w.api(w.owner, w.R.advances.POST, { method: "POST", body: { partnerKind: "PARTNER", kind: "DRAW", docDate: "2026-05-03", cashAccountId: w.ids.cashIQD, currency: "IQD", amount: "80000", note: "سحب شخصي" } });
    expect((await w.api(w.acct, w.R.advancePost, { method: "POST", params: { id: adv.body.id } })).status).toBe(403);       // owner-only approval
    expect((await w.api(w.owner, w.R.advancePost, { method: "POST", params: { id: adv.body.id } })).status).toBe(200);
    expect(await D("1250")).toBe(80000);
    const before = await w.tb();
    expect((await postExp(x.body.id)).status).toBe(200);
    const tb = await w.tb();
    expect(bal(tb, "1250") - bal(before, "1250")).toBe(-50000); expect(bal(tb, "2300")).toBe(bal(before, "2300"));     // advance consumed, no payable left, expense recognised once
    expect(bal(tb, "6600") - bal(before, "6600")).toBe(50000);
  });
  it("personal draws are NOT operating expenses: the owner's draw goes to equity 3200", async () => {
    const exp0 = (await w.tb()).rows.filter((r: any) => r.type === "EXPENSE").reduce((s: number, r: any) => s + Number(r.debit) - Number(r.credit), 0);
    const d1 = await w.api(w.owner, w.R.advances.POST, { method: "POST", body: { partnerKind: "OWNER", kind: "DRAW", docDate: "2026-05-04", cashAccountId: w.ids.cashIQD, currency: "IQD", amount: "20000" } });
    await w.api(w.owner, w.R.advancePost, { method: "POST", params: { id: d1.body.id } });
    const tb = await w.tb();
    expect(bal(tb, "3200")).toBe(20000);
    expect(tb.rows.filter((r: any) => r.type === "EXPENSE").reduce((s: number, r: any) => s + Number(r.debit) - Number(r.credit), 0)).toBe(exp0);
  });
});

describe("accrued expenses and reversal", () => {
  it("an accrued expense is recognised once; payments reduce 2210; reversal is blocked while payments exist", async () => {
    const cat = await w.cat("إيجارات");
    const x = await exp({ categoryId: cat, amount: "100000", paymentMode: "ACCRUED" });
    const before = await w.tb(); await postExp(x.body.id); const mid = await w.tb();
    expect(bal(mid, "6300") - bal(before, "6300")).toBe(100000); expect(-bal(mid, "2210") - -bal(before, "2210")).toBe(100000);
    const p1 = await w.api(w.owner, w.R.expensePay.POST, { method: "POST", body: { expenseId: x.body.id, docDate: "2026-06-01", cashAccountId: w.ids.cashIQD, amount: "40000" } });
    expect(p1.status).toBe(200);
    expect((await w.api(w.owner, w.R.expenseReverse, { method: "POST", params: { id: x.body.id }, body: { reason: "اختبار" } })).body.error.code).toBe("HAS_PAYMENTS");
    const pr = await import("@/app/api/expense-payments/[id]/reverse/route");
    expect((await w.api(w.owner, pr.POST, { method: "POST", params: { id: p1.body.id }, body: { reason: "دفعة خاطئة" } })).status).toBe(200);
    expect((await w.api(w.owner, w.R.expenseReverse, { method: "POST", params: { id: x.body.id }, body: { reason: "مصروف مكرر" } })).status).toBe(200);
    expect(bal(await w.tb(), "6300")).toBe(bal(before, "6300")); expect((await w.tb()).balanced).toBe(true);
    await expectFail(w.inject((tx) => tx`UPDATE expenses SET amount = 1 WHERE id = ${x.body.id}`), /REVERSED_DOCUMENT_IMMUTABLE|POSTED_DOCUMENT_IMMUTABLE/);
  });
});

describe("accounting periods", () => {
  it("a closed month rejects postings dated inside it; only the owner closes/reopens; unfinished months and drafts block closing", async () => {
    expect((await w.api(w.acct, w.R.periods.POST, { method: "POST", body: { month: "2026-03" } })).status).toBe(403);
    expect((await w.api(w.owner, w.R.periods.POST, { method: "POST", body: { month: "2099-01" } })).body.error.code).toBe("PERIOD_NOT_FINISHED");
    const draft = await exp({ docDate: "2026-02-10", categoryId: await w.cat("ضيافة ومتفرقات"), amount: "1000", paymentMode: "ACCRUED" });
    expect((await w.api(w.owner, w.R.periods.POST, { method: "POST", body: { month: "2026-02" } })).body.error.code).toBe("DRAFTS_EXIST");
    await w.api(w.owner, w.R.expenseId.DELETE, { method: "DELETE", params: { id: draft.body.id } });
    expect((await w.api(w.owner, w.R.periods.POST, { method: "POST", body: { month: "2026-02" } })).status).toBe(200);
    expect((await w.api(w.owner, w.R.periods.POST, { method: "POST", body: { month: "2026-02" } })).body.error.code).toBe("ALREADY_CLOSED");
    const late = await exp({ docDate: "2026-02-20", categoryId: await w.cat("ضيافة ومتفرقات"), amount: "1000", paymentMode: "ACCRUED" });
    const r = await postExp(late.body.id); expect(r.status).toBe(409); expect(r.body.error.code).toBe("PERIOD_CLOSED");
    const snap = await w.env.admin`SELECT snapshot FROM accounting_periods WHERE period_month = '2026-02-01'`; expect(snap[0]!.snapshot.balanced).toBe(true);
    const re = await w.api(w.owner, w.R.periods.DELETE, { method: "DELETE", body: { month: "2026-02", reason: "تصحيح قيد متأخر" } });
    expect(re.status).toBe(200);
    expect((await postExp(late.body.id)).status).toBe(200);
  });
});

describe("expense permissions and audit", () => {
  it("accountant can record and post expenses by default but not reverse; everything is audited", async () => {
    const x = await exp({ categoryId: await w.cat("ضيافة ومتفرقات"), amount: "2000", paymentMode: "ACCRUED" }, w.acct);
    expect((await postExp(x.body.id, w.acct)).status).toBe(200);
    expect((await w.api(w.acct, w.R.expenseReverse, { method: "POST", params: { id: x.body.id }, body: { reason: "اختبار" } })).status).toBe(403);
    const n = await w.env.admin`SELECT count(*)::int n FROM audit_logs WHERE action IN ('expense.post','capital.approve_injection','payroll.accrue','personal_advance.post')`;
    expect(n[0]!.n).toBeGreaterThan(3);
  });
});
