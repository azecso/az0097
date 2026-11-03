import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeWorld, capital, bal, op, uid, type World } from "./world";

let w: World; let push: any; let P: string;
beforeAll(async () => { w = await makeWorld(); await capital(w, "50000000"); push = await import("@/app/api/sync/push/route"); P = await w.mkProduct("OFF1"); await w.buy({ product: P, qty: "10", price: "1000" }); });
afterAll(async () => { await w.env.teardown(); });

const send = (s: any, device: string, ops: any[]) => w.api(s, push.POST, { method: "POST", body: { deviceId: device, operations: ops } });
const invoicePayload = (qty: string, extra: Record<string, unknown> = {}) => ({ customerId: w.ids.customer, docDate: "2026-06-01", saleType: "CREDIT", currency: "IQD", lines: [{ productId: P, uom: "قطعة", qty, unitPrice: "3000" }], ...extra });
const stock = async () => (await w.api(w.owner, w.R.stock)).body.filter((s: any) => s.productId === P).reduce((a: number, s: any) => a + Number(s.qty), 0);

describe("offline sync: drafts only, the server decides everything financial", () => {
  it("creates a draft from a device operation; replaying the same operation (or idempotency key) never duplicates it", async () => {
    const local = uid(); const create = op({ entity: "sales_invoice", kind: "CREATE_DRAFT", local, payload: invoicePayload("2") });
    const r1 = await send(w.owner, "dev-A", [create]);
    expect(r1.status).toBe(200); expect(r1.body.results[0].status).toBe("ACCEPTED"); expect(r1.body.results[0].draftRef).toMatch(/^DRAFT-/); expect(r1.body.results[0].docNo).toBeUndefined();   // no final number offline
    const before = (await w.api(w.owner, w.R.invoices.GET)).body.length;
    const r2 = await send(w.owner, "dev-A", [create]);                                                // network retry
    expect(r2.body.results[0].serverId).toBe(r1.body.results[0].serverId);
    const r3 = await send(w.owner, "dev-A", [{ ...create, operationId: uid() }]);                      // same idempotency key, new op id
    expect(r3.body.results[0].serverId).toBe(r1.body.results[0].serverId);
    expect((await w.api(w.owner, w.R.invoices.GET)).body.length).toBe(before);
    const ledgerBefore = await w.tb(); expect(ledgerBefore.balanced).toBe(true);
    expect(((await w.api(w.owner, w.R.invoiceId.GET, { params: { id: r1.body.results[0].serverId } })).body).status).toBe("DRAFT");        // nothing posted, no FIFO consumed
    expect(await stock()).toBe(10);
  });

  it("queued dependent operations resolve the server id by the local id (create + submit in one batch)", async () => {
    const local = uid();
    const r = await send(w.owner, "dev-A", [op({ entity: "sales_invoice", kind: "CREATE_DRAFT", local, payload: invoicePayload("1") }), op({ entity: "sales_invoice", kind: "SUBMIT_FOR_POSTING", local })]);
    expect(r.body.results.map((x: any) => x.status)).toEqual(["ACCEPTED", "ACCEPTED"]);
    expect(r.body.results[1].docNo).toMatch(/^INV-2026-/);                                              // the number exists only after the server validated and posted
    expect(await stock()).toBe(9);
  });

  it("two devices sell the same stock offline: the first to sync posts, the second is a CONFLICT and stays a draft; stock never negative", async () => {
    // 9 units left. Device A sold 8, device B sold 8 (each saw 9 offline).
    const a = uid(), b = uid();
    const ra = await send(w.owner, "dev-A", [op({ entity: "sales_invoice", kind: "CREATE_DRAFT", local: a, payload: invoicePayload("8") })]);
    const rb = await send(w.acct, "dev-B", [op({ entity: "sales_invoice", kind: "CREATE_DRAFT", local: b, payload: invoicePayload("8") })]);
    const sub = await Promise.all([send(w.owner, "dev-A", [op({ entity: "sales_invoice", kind: "SUBMIT_FOR_POSTING", local: a })]), send(w.acct, "dev-B", [op({ entity: "sales_invoice", kind: "SUBMIT_FOR_POSTING", local: b })])]);
    const results = sub.map((x) => x.body.results[0]);
    expect(results.filter((x: any) => x.status === "ACCEPTED").length).toBe(1);
    const conflict = results.find((x: any) => x.status === "CONFLICT");
    expect(conflict.code).toBe("INSUFFICIENT_STOCK"); expect(conflict.message).toContain("المتاح");
    expect(await stock()).toBe(1);
    const loser = results[0].status === "CONFLICT" ? ra.body.results[0].serverId : rb.body.results[0].serverId;
    expect((await w.api(w.owner, w.R.invoiceId.GET, { params: { id: loser } })).body.status).toBe("DRAFT");           // kept for the user to fix
    const c = await w.env.admin`SELECT kind FROM sync_conflicts`; expect(c.some((x) => x.kind === "INSUFFICIENT_STOCK")).toBe(true);
    expect((await w.recon()).ok).toBe(true); expect((await w.tb()).balanced).toBe(true);
  });

  it("version mismatch is a CONFLICT with the server snapshot (no last-write-wins), a fresh base version is accepted", async () => {
    const local = uid();
    const c = await send(w.owner, "dev-A", [op({ entity: "sales_invoice", kind: "CREATE_DRAFT", local, payload: invoicePayload("1") })]);
    const sid = c.body.results[0].serverId, v = c.body.results[0].version;
    const edit = (qty: string, base: number) => op({ entity: "sales_invoice", kind: "UPDATE_DRAFT", local, base, payload: { serverId: sid, ...invoicePayload(qty) } });
    expect((await send(w.owner, "dev-A", [edit("1", v)])).body.results[0].status).toBe("ACCEPTED");               // device A edits first
    const stale = (await send(w.acct, "dev-B", [edit("1", v)])).body.results[0];                                  // device B still on the old version
    expect(stale.status).toBe("CONFLICT"); expect(stale.code).toBe("VERSION_CONFLICT"); expect(stale.serverSnapshot.version).toBe(v + 1);
    expect((await send(w.acct, "dev-B", [edit("1", v + 1)])).body.results[0].status).toBe("ACCEPTED");
  });

  it("validation errors are REJECTED with field issues and create nothing; unknown entities are refused", async () => {
    const bad = await send(w.owner, "dev-A", [op({ entity: "sales_invoice", kind: "CREATE_DRAFT", local: uid(), payload: { ...invoicePayload("1"), lines: [{ productId: P, uom: "قطعة", qty: "-3", unitPrice: "1" }] } })]);
    expect(bad.body.results[0].status).toBe("REJECTED"); expect(bad.body.results[0].code).toBe("VALIDATION"); expect(bad.body.results[0].issues.length).toBeGreaterThan(0);
    expect((await send(w.owner, "dev-A", [{ ...op({ entity: "sales_invoice", kind: "CREATE_DRAFT", local: uid() }), entityType: "journal_entry" }])).status).toBe(400);
  });

  it("permissions are re-checked at sync time; a closed period turns a submit into a CONFLICT", async () => {
    // the month is closed BEFORE the offline device syncs its (back-dated) draft
    expect((await w.api(w.owner, w.R.periods.POST, { method: "POST", body: { month: "2026-01" } })).status).toBe(200);
    const local = uid();
    const created = (await send(w.acct, "dev-B", [op({ entity: "sales_invoice", kind: "CREATE_DRAFT", local, payload: invoicePayload("1", { docDate: "2026-01-10" }) })])).body.results[0];
    expect(created.status).toBe("ACCEPTED");                                                           // drafts may exist in a closed month...
    const closed = (await send(w.owner, "dev-A", [op({ entity: "sales_invoice", kind: "SUBMIT_FOR_POSTING", local })])).body.results[0];
    expect(closed.status).toBe("CONFLICT"); expect(closed.code).toBe("PERIOD_CLOSED");                  // ...but never post into it
    // the owner removes the accountant's posting right after a draft was written offline
    const local2 = uid();
    await send(w.acct, "dev-B", [op({ entity: "sales_invoice", kind: "CREATE_DRAFT", local: local2, payload: invoicePayload("1", { docDate: "2026-06-05" }) })]);
    const users = await import("@/app/api/users/route"); const perms = await import("@/app/api/users/[id]/permissions/route");
    const acctId = (await w.api(w.owner, users.GET)).body.find((u: any) => u.username === "acc").id;
    const granted = (await w.api(w.owner, perms.GET, { params: { id: acctId } })).body.granted.filter((g: any) => !(g.resource === "sales" && g.action === "approve"));
    await w.api(w.owner, perms.PUT, { method: "PUT", params: { id: acctId }, body: { permissions: granted } });
    const r = (await send(w.acct, "dev-B", [op({ entity: "sales_invoice", kind: "SUBMIT_FOR_POSTING", local: local2 })]));
    expect(r.status === 401 || (r.body.results?.[0].status === "REJECTED" && r.body.results[0].code === "PERMISSION_DENIED")).toBe(true);
  });

  it("offline receipts and expenses are drafts too; receipt posting is validated by the server (cannot over-allocate)", async () => {
    const inv = (await w.sale({ product: P, qty: "1", price: "5000", date: "2026-07-01" }));
    if (inv.status !== 200) { await w.buy({ product: P, qty: "5", price: "1000", date: "2026-07-01" }); }
    const invoice = inv.status === 200 ? inv : await w.sale({ product: P, qty: "1", price: "5000", date: "2026-07-01" });
    const rl = uid();
    const rc = await send(w.owner, "dev-A", [op({ entity: "customer_receipt", kind: "CREATE_DRAFT", local: rl, payload: { customerId: w.ids.customer, docDate: "2026-07-02", kind: "CASH", cashAccountId: w.ids.cashIQD, currency: "IQD", amount: "9000", allocations: [{ invoiceId: invoice.id, amount: "9000" }] } })]);
    expect(rc.body.results[0].status).toBe("REJECTED"); expect(rc.body.results[0].code).toBe("OVER_ALLOCATION");   // 5,000 invoice
    const ok = await send(w.owner, "dev-A", [op({ entity: "customer_receipt", kind: "CREATE_DRAFT", local: uid(), payload: { customerId: w.ids.customer, docDate: "2026-07-02", kind: "CASH", cashAccountId: w.ids.cashIQD, currency: "IQD", amount: "5000", allocations: [{ invoiceId: invoice.id, amount: "5000" }] } })]);
    expect(ok.body.results[0].status).toBe("ACCEPTED");
    const ex = await send(w.owner, "dev-A", [op({ entity: "expense", kind: "CREATE_DRAFT", local: uid(), payload: { docDate: "2026-07-03", categoryId: await w.cat("صيانة"), description: "إصلاح", currency: "IQD", amount: "10000", paymentMode: "ACCRUED" } })]);
    expect(ex.body.results[0].status).toBe("ACCEPTED");
    expect(bal(await w.tb(), "6600")).toBe(0);                                                          // a draft expense is not in the books
  });

  it("the sync log is audited and listable per user/device; unauthenticated or cross-origin pushes are refused", async () => {
    const list = (await w.api(w.owner, (await import("@/app/api/sync/operations/route")).GET)).body;
    expect(list.length).toBeGreaterThan(3); expect((await w.env.admin`SELECT count(*)::int n FROM sync_operations WHERE status = 'CONFLICT'`)[0]!.n).toBeGreaterThan(1);
    expect((await w.api(null as any, push.POST, { method: "POST", body: { deviceId: "x", operations: [] } })).status).toBe(401);
    expect((await w.api(w.owner, push.POST, { method: "POST", origin: "http://evil.example", body: { deviceId: "dev-A", operations: [op({ entity: "expense", kind: "CREATE_DRAFT", local: uid() })] } } as any)).status).toBe(403);
    const n = await w.env.admin`SELECT count(*)::int n FROM audit_logs WHERE action LIKE 'sync.%'`; expect(n[0]!.n).toBeGreaterThan(5);
  });
});
