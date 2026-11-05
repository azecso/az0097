"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api } from "@/lib/client";
import { tafqeet } from "@/lib/tafqeet";
import { Loading, M, statusStamp, usePrint, type Co } from "@/components/print";
import "./invoice-print.css";

interface Inv { docNo: string | null; draftRef: string; docDate: string; dueDate: string | null; customerName: string; customerPhones: string[] | null; customerAddress: string | null;
  saleType: string; currency: string; exchangeRate: string; gross: string; discount: string; net: string; terms: string | null; notes: string | null; status: string;
  collected?: string; appliedToReceivable?: string; outstanding?: string;
  lines: { lineNo: number; productCode: string; productName: string; uom: string; qty: string; unitPrice: string; lineDiscount: string; lineTotal: string }[] }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** Footer repeated by Chromium on every PDF page: company data from Settings + page numbers. Inline styles only (it renders outside the page's CSS). */
function footerHtml(co: Co, contact: { k: string; v: string }[]) {
  const line = [esc(co.name), co.nameEn ? esc(co.nameEn) : "", co.address ? esc(co.address) : ""].filter(Boolean).join(" — ");
  const rows = contact.map((c) => `<span style="margin:0 6px">${esc(c.k)}: <span dir="ltr">${esc(c.v)}</span></span>`).join("");
  return `<div style="width:100%;margin:0 12mm;border-top:2px solid #b8892b;padding-top:3px;font-family:'Noto Sans Arabic','Noto Naskh Arabic','Cairo','DejaVu Sans',sans-serif;font-size:8.5px;color:#3a4556;text-align:center;direction:rtl"><div><b style="color:#12233d">${line}</b></div><div>${rows}</div><div style="margin-top:2px;color:#4a5568">صفحة <span class="pageNumber"></span> من <span class="totalPages"></span></div></div>`;
}
export default function PrintInvoice() {
  const { id } = useParams<{ id: string }>(); const { data: d, co, err } = usePrint<Inv>(`/api/sales-invoices/${id}`);
  const [who, setWho] = useState<string | null>(null);
  useEffect(() => { api<{ user: { displayName: string } }>("/api/auth/me").then((m) => setWho(m.user.displayName)).catch(() => setWho("")); }, []);     // the person printing right now (session of this print), not the creator
  if (!d || !co || who === null) return <Loading err={err} />;
  const posted = d.collected !== undefined; const hasDisc = Number(d.discount) > 0 || d.lines.some((l) => Number(l.lineDiscount) > 0);
  const words = d.currency === "IQD" ? tafqeet(Number(d.net)) : tafqeet(Number(d.net), "دولار أمريكي");
  const contact = [co.phones && co.phones.length ? { k: "هاتف", v: co.phones.join(" - ") } : null, co.email ? { k: "البريد", v: co.email } : null, co.website ? { k: "الموقع", v: co.website } : null, co.taxNo ? { k: "الرقم الضريبي", v: co.taxNo } : null].filter(Boolean) as { k: string; v: string }[];
  return (<div className="print-root" dir="rtl">
    <div className="print-bar"><a href={`/api/pdf?path=${encodeURIComponent(`/print/sales-invoice/${id}`)}`} target="_blank" rel="noreferrer"><button>🖨 طباعة (PDF رسمي A4)</button></a><a href={`/api/pdf?path=${encodeURIComponent(`/print/sales-invoice/${id}`)}`} download>⬇ تنزيل PDF</a></div>
    <template id="pdf-footer" dangerouslySetInnerHTML={{ __html: footerHtml(co, contact) }} />
    <div className="inv" data-ready="1">
      <div className="wm" aria-hidden="true"><img src="/brand/logo.webp" alt="" /><b>{co.name}</b>{co.nameEn && <i>{co.nameEn}</i>}</div>
      <div className="foot"><div><b>{co.name}</b>{co.nameEn && <> — <span className="en">{co.nameEn}</span></>}{co.address && <> — {co.address}</>}</div>
        {contact.length > 0 && <div className="row2">{contact.map((c) => <span key={c.k}>{c.k}: <span className="num">{c.v}</span></span>)}</div>}</div>
      <div className="content">
        <div className="head">
          <div className="brand"><img src="/brand/logo.webp" alt="شعار الشركة" /><div><div className="ar">{co.name}</div>{co.nameEn && <div className="enm en">{co.nameEn}</div>}</div></div>
          <div className="title"><b>فاتورة بيع</b><small>SALES INVOICE</small></div>
        </div>
        {statusStamp(d.status) && <div className="stampbar">{statusStamp(d.status)}</div>}
        <div className="boxes">
          <div className="box"><h3>بيانات الفاتورة</h3><dl>
            <dt>رقم الفاتورة</dt><dd className="num">{d.docNo ?? d.draftRef}</dd><dt>التاريخ</dt><dd className="num">{d.docDate}</dd>
            <dt>تاريخ الاستحقاق</dt><dd className="num">{d.dueDate ?? "—"}</dd><dt>نوع البيع</dt><dd>{d.saleType === "CASH" ? "نقدي" : "آجل"}</dd>
            <dt>العملة</dt><dd>{d.currency === "IQD" ? "دينار عراقي (IQD)" : `${d.currency} — سعر الصرف ${Number(d.exchangeRate)}`}</dd></dl></div>
          <div className="box"><h3>بيانات العميل</h3><dl>
            <dt>اسم العميل</dt><dd>{d.customerName}</dd><dt>الهاتف</dt><dd className="num">{d.customerPhones && d.customerPhones.length ? d.customerPhones.join(" - ") : "—"}</dd>
            <dt>العنوان</dt><dd>{d.customerAddress || "—"}</dd></dl></div>
        </div>
        <table className="items"><thead><tr><th style={{ width: "6%" }}>#</th><th>اسم الصنف</th><th style={{ width: "9%" }}>الوحدة</th><th style={{ width: "10%" }}>الكمية</th><th style={{ width: "15%" }}>سعر الوحدة</th>{hasDisc && <th style={{ width: "11%" }}>الخصم</th>}<th style={{ width: "16%" }}>الإجمالي</th></tr></thead>
          <tbody>{d.lines.map((l) => <tr key={l.lineNo}><td className="c">{l.lineNo}</td><td>{l.productName}<div className="code num">{l.productCode}</div></td><td className="c">{l.uom}</td><td className="c"><M v={l.qty} /></td><td className="e"><M v={l.unitPrice} /></td>{hasDisc && <td className="e"><M v={l.lineDiscount} /></td>}<td className="e"><M v={l.lineTotal} /></td></tr>)}</tbody></table>
        <div className="final">
          <div className="sumrow">
            <div><div className="words"><small>المبلغ كتابةً</small>{words}</div>{(d.terms || d.notes) && <div className="notes"><b>الشروط والملاحظات:</b> {[d.terms, d.notes].filter(Boolean).join(" — ")}</div>}</div>
            <table className="sum"><tbody>
              {(Number(d.discount) > 0) && <><tr><td>الإجمالي قبل الخصم</td><td><M v={d.gross} /></td></tr><tr><td>الخصم</td><td><M v={d.discount} /></td></tr></>}
              <tr className="net"><td>صافي الفاتورة ({d.currency})</td><td><M v={d.net} /></td></tr>
              {posted && <><tr><td>المدفوع</td><td><M v={d.collected} /></td></tr>{Number(d.appliedToReceivable) > 0 && <tr><td>مرتجعات / إشعارات دائنة</td><td><M v={d.appliedToReceivable} /></td></tr>}
                <tr className="due"><td>المتبقي</td><td><M v={d.outstanding} /></td></tr></>}
            </tbody></table>
          </div>
          <div className="sign">
            <div className="who"><span>المحاسب</span><b>{who || " "}</b></div>
            <div className="seal"><img src="/brand/stamp.webp" alt="ختم الشركة" /></div>
            <div className="who"><span>المستلم</span><b>{d.customerName}</b></div>
          </div>
        </div>
      </div>
    </div></div>);
}
