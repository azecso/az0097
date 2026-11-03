"use client";
import { useState } from "react";
import { api, money } from "@/lib/client";
import { useLoad } from "@/components/ui";

interface S { productId: string; code: string; name: string; baseUom: string; location: string; warehouseKind: string; qty: string; value: string }
interface Lot { id: string; location: string; receivedAt: string; qtyReceived: string; qtyRemaining: string; unitCostBase: string; costRemaining: string; originType: string }
const ORIGIN: Record<string, string> = { purchase_order: "شراء", stock_transfer: "نقل", inventory_count: "جرد" };
export default function Stock() {
  const { data, err } = useLoad<S[]>("/api/stock", []); const rec = useLoad<{ ok: boolean; main: { lots: string; ledger: string }; partner: { lots: string; ledger: string } } | null>("/api/reports/inventory-reconciliation", null).data;
  const [lots, setLots] = useState<{ name: string; rows: Lot[] } | null>(null);
  const total = (k: string) => data.filter((s) => s.warehouseKind === k).reduce((a, s) => a + Number(s.value), 0);
  return (<>
    <h1>المخزون (FIFO)</h1>
    <div className="grid">
      <div className="card stat"><div className="label">قيمة المخزون — الرئيسي</div><div className="value"><span className="num">{money(total("MAIN"))}</span></div></div>
      <div className="card stat"><div className="label">قيمة المخزون — عهدة الشريك</div><div className="value"><span className="num">{money(total("PARTNER_CUSTODY"))}</span></div></div>
      {rec && <div className="card stat"><div className="label">مطابقة المخزون مع الدفتر</div><div className="value">{rec.ok ? "✔ متطابق" : "⚠ فرق"}</div></div>}
    </div>
    <p style={{ display: "flex", gap: 8 }}><a href="/api/export/stock"><button>⬇ Excel</button></a><a href="/print/report/stock" target="_blank" rel="noreferrer"><button>طباعة / PDF</button></a></p>
    {err && <div className="msg err">{err}</div>}
    <div className="card cards-as-list" style={{ marginTop: 12 }}><table><thead><tr><th>الكود</th><th>المادة</th><th>الموقع</th><th>الكمية</th><th>القيمة (IQD)</th><th></th></tr></thead>
      <tbody>{data.map((s) => <tr key={s.productId + s.location}><td><span className="num">{s.code}</span></td><td>{s.name}</td><td>{s.location}</td><td><span className="num">{money(s.qty)} {s.baseUom}</span></td><td><span className="num">{money(s.value)}</span></td>
        <td><button onClick={() => api<Lot[]>(`/api/products/${s.productId}/lots`).then((rows) => setLots({ name: s.name, rows }))}>الطبقات</button></td></tr>)}
        {data.length === 0 && <tr><td colSpan={6}>لا يوجد مخزون بعد</td></tr>}</tbody></table></div>
    {lots && <div className="card" style={{ marginTop: 12, overflowX: "auto" }}><h2>طبقات FIFO — {lots.name}</h2>
      <table><thead><tr><th>تاريخ الاستلام</th><th>الموقع</th><th>المصدر</th><th>المستلم</th><th>المتبقي</th><th>تكلفة الوحدة</th><th>قيمة المتبقي</th></tr></thead>
        <tbody>{lots.rows.map((l) => <tr key={l.id}><td><span className="num">{l.receivedAt.slice(0, 10)}</span></td><td>{l.location}</td><td>{ORIGIN[l.originType] ?? l.originType}</td><td><span className="num">{money(l.qtyReceived)}</span></td><td><span className="num">{money(l.qtyRemaining)}</span></td><td><span className="num">{money(l.unitCostBase)}</span></td><td><span className="num">{money(l.costRemaining)}</span></td></tr>)}</tbody></table></div>}
  </>);
}
