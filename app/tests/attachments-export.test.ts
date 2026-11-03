import { afterAll, beforeAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { makeWorld, capital, bal, type World } from "./world";
import { ORIGIN } from "./helpers";
import { tafqeet } from "@/lib/tafqeet";

let w: World; let up: any, one: any, exp: any;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
beforeAll(async () => { process.env.UPLOAD_DIR = mkdtempSync(join(tmpdir(), "erp-up-")); w = await makeWorld(); await capital(w);
  up = await import("@/app/api/attachments/route"); one = await import("@/app/api/attachments/[id]/route"); exp = (await import("@/app/api/export/[kind]/route")).GET; });
afterAll(async () => { await w.env.teardown(); });

const upload = async (s: { cookie: string; csrf: string }, fields: Record<string, string>, file: { name: string; data: Buffer; type?: string }) => {
  const fd = new FormData(); for (const [k, v] of Object.entries(fields)) fd.set(k, v); fd.set("file", new File([new Uint8Array(file.data)], file.name, { type: file.type ?? "image/png" }));
  const req = new NextRequest(ORIGIN + "/api/attachments", { method: "POST", body: fd, headers: { host: "localhost:3000", origin: ORIGIN, cookie: s.cookie, "x-csrf-token": s.csrf } });
  const res = await up.POST(req); return { status: res.status, body: await res.json() };
};
const download = async (s: { cookie: string; csrf: string }, id: string) => one.GET(new NextRequest(ORIGIN + "/api/attachments/" + id, { headers: { host: "localhost:3000", cookie: s.cookie } }), { params: Promise.resolve({ id }) });

describe("attachments: type is checked from the bytes, size capped, permissions enforced", () => {
  it("accepts a real PNG as company logo; the logo becomes part of the company profile; it downloads with nosniff", async () => {
    const r = await upload(w.owner, { entityType: "company_logo", entityId: w.env.companyId }, { name: "logo.png", data: PNG });
    expect(r.status).toBe(200); expect(r.body.mime).toBe("image/png");
    const co = (await w.api(w.owner, (await import("@/app/api/company/route")).GET)).body; expect(co.logoAttachmentId).toBe(r.body.id);
    const dl = await download(w.owner, r.body.id);
    expect(dl.status).toBe(200); expect(dl.headers.get("content-type")).toBe("image/png"); expect(dl.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await dl.arrayBuffer()).equals(PNG)).toBe(true);
    const row = (await w.env.admin`SELECT storage_name FROM attachments WHERE id = ${r.body.id}`)[0]!; expect(row.storage_name).toMatch(/^[0-9a-f]{64}\.png$/);   // no user-controlled path
    expect(existsSync(join(process.env.UPLOAD_DIR!, w.env.companyId, row.storage_name))).toBe(true);
  });
  it("rejects fake images (HTML/script renamed .png), PDFs as logos, oversize files and unknown entities", async () => {
    const fake = await upload(w.owner, { entityType: "company_logo", entityId: w.env.companyId }, { name: "x.png", data: Buffer.from("<script>alert(1)</script>"), type: "image/png" });
    expect(fake.status).toBe(400); expect(fake.body.error.code).toBe("FILE_TYPE");
    const pdf = await upload(w.owner, { entityType: "company_signature", entityId: w.env.companyId }, { name: "s.pdf", data: Buffer.from("%PDF-1.4\n%x"), type: "application/pdf" });
    expect(pdf.body.error.code).toBe("FILE_TYPE");
    const big = await upload(w.owner, { entityType: "product", entityId: uid0() }, { name: "big.png", data: Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]) });
    expect(big.body.error.code).toBe("FILE_SIZE");
    expect((await upload(w.owner, { entityType: "journal_entry", entityId: uid0() }, { name: "a.png", data: PNG })).status).toBe(400);
    expect((await upload(w.owner, { entityType: "product", entityId: uid0() }, { name: "a.png", data: PNG })).status).toBe(404);             // entity must exist in this company
  });
  it("document attachments (invoice scans, product images); permission-gated; soft delete is audited", async () => {
    const P = await w.mkProduct("ATT");
    const a = await upload(w.acct, { entityType: "product", entityId: P }, { name: "../../etc/passwd.png", data: PNG });
    expect(a.status).toBe(200); expect(a.body.name).not.toContain("/");                                                                                 // traversal characters neutralised
    const co = await upload(w.acct, { entityType: "company_logo", entityId: w.env.companyId }, { name: "l.png", data: PNG });
    expect(co.status).toBe(403);                                                                                                                         // company branding is owner-only
    const list = (await w.api(w.owner, up.GET, { path: `/api/attachments?entityType=product&entityId=${P}` } as any)).body; expect(list.length).toBe(1);
    expect((await w.api(w.owner, one.DELETE, { method: "DELETE", params: { id: a.body.id } })).status).toBe(200);
    expect((await download(w.owner, a.body.id)).status).toBe(404);
    expect((await w.env.admin`SELECT count(*)::int n FROM audit_logs WHERE action IN ('attachment.upload','attachment.delete')`)[0]!.n).toBeGreaterThanOrEqual(3);
  });
});

describe("Excel export matches the on-screen figures", () => {
  it("trial balance workbook: RTL, numeric cells, SUM formulas with correct cached totals equal to the API", async () => {
    const P = await w.mkProduct("XL"); await w.buy({ product: P, qty: "10", price: "1000" }); await w.sale({ product: P, qty: "10", price: "2500" });
    const res = await exp(new NextRequest(ORIGIN + "/api/export/trial-balance", { headers: { host: "localhost:3000", cookie: w.owner.cookie } }), { params: Promise.resolve({ kind: "trial-balance" }) });
    expect(res.status).toBe(200); expect(res.headers.get("content-type")).toContain("spreadsheetml");
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as never);
    const ws = wb.worksheets[0]!; expect(ws.views[0]!.rightToLeft).toBe(true);
    const tb = await w.tb(); const rows = ws.getSheetValues().slice(2) as any[];
    const total = rows[rows.length - 1]; expect(total[1]).toBe("الإجمالي");
    expect(total[3].result).toBe(Number(tb.totalDebit)); expect(total[4].result).toBe(Number(tb.totalCredit)); expect(total[3].formula).toMatch(/^SUM\(/);
    const cash = rows.find((r: any) => r?.[1] === "1110"); expect(typeof cash[3]).toBe("number"); expect(cash[3] - cash[4]).toBe(bal(tb, "1110"));
    expect((await exp(new NextRequest(ORIGIN + "/api/export/nope", { headers: { host: "localhost:3000", cookie: w.owner.cookie } }), { params: Promise.resolve({ kind: "nope" }) })).status).toBe(400);
    expect((await exp(new NextRequest(ORIGIN + "/api/export/stock", { headers: { host: "localhost:3000" } }), { params: Promise.resolve({ kind: "stock" }) })).status).toBe(401);
  });
  it("customer statement export carries the running balance", async () => {
    const res = await exp(new NextRequest(ORIGIN + `/api/export/customer-statement?id=${w.ids.customer}`, { headers: { host: "localhost:3000", cookie: w.owner.cookie } }), { params: Promise.resolve({ kind: "customer-statement" }) });
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as never);
    const rows = wb.worksheets[0]!.getSheetValues().slice(2) as any[]; expect(rows.length).toBeGreaterThan(1);
    expect(rows[rows.length - 2][7]).toBe(25000);                                                                                                          // 10 x 2,500 receivable
  });
});

describe("amount in Arabic words (tafqeet)", () => {
  it("writes voucher amounts correctly", () => {
    expect(tafqeet(0)).toBe("صفر دينار عراقي لا غير");
    expect(tafqeet(1500)).toBe("فقط ألف وخمسمائة دينار عراقي لا غير");
    expect(tafqeet(2000)).toContain("ألفان"); expect(tafqeet(10000)).toContain("عشرة آلاف"); expect(tafqeet(1250000)).toContain("مليون"); expect(tafqeet(250, "دولار أمريكي")).toBe("فقط مائتان وخمسون دولار أمريكي لا غير");
    expect(tafqeet(1_000_000_000)).toContain("مليار"); expect(tafqeet(21)).toContain("واحد وعشرون");
  });
});
const uid0 = () => "11111111-1111-4111-8111-111111111111";
