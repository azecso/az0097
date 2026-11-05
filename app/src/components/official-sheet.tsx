"use client";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { api } from "@/lib/client";
import { Loading, statusStamp, type Co } from "@/components/print";
import "./official-sheet.css";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export const contactOf = (co: Co) => [co.phones && co.phones.length ? { k: "هاتف", v: co.phones.join(" - ") } : null, co.email ? { k: "البريد", v: co.email } : null, co.website ? { k: "الموقع", v: co.website } : null, co.taxNo ? { k: "الرقم الضريبي", v: co.taxNo } : null].filter(Boolean) as { k: string; v: string }[];

/** Footer repeated by Chromium on every PDF page: company data from Settings + page numbers. Inline styles only (it renders outside the page's CSS). */
function footerHtml(co: Co) {
  const line = [esc(co.name), co.nameEn ? esc(co.nameEn) : "", co.address ? esc(co.address) : ""].filter(Boolean).join(" — ");
  const rows = contactOf(co).map((c) => `<span style="margin:0 6px">${esc(c.k)}: <span dir="ltr">${esc(c.v)}</span></span>`).join("");
  return `<div style="width:100%;margin:0 12mm;border-top:2px solid #b8892b;padding-top:3px;font-family:'Noto Sans Arabic','Noto Naskh Arabic','Cairo','DejaVu Sans',sans-serif;font-size:8.5px;color:#3a4556;text-align:center;direction:rtl"><div><b style="color:#12233d">${line}</b></div><div>${rows}</div><div style="margin-top:2px;color:#4a5568">صفحة <span class="pageNumber"></span> من <span class="totalPages"></span></div></div>`;
}

/** The person printing right now (this print session) — never the creator of the document. */
export function useWho() {
  const [who, setWho] = useState<string | null>(null);
  useEffect(() => { api<{ user: { displayName: string } }>("/api/auth/me").then((m) => setWho(m.user.displayName)).catch(() => setWho("")); }, []);
  return who;
}

/** Shared official A4 layout: header with fixed logo, boxes, body, final block (words/summary + signatures + stamp), watermark, per-page footer. */
/** Label/value rows for a .box. A third element true = LTR number (phones, ids). */
export function Dl({ title, rows }: { title: string; rows: [string, ReactNode, boolean?][] }) {
  return <div className="box"><h3>{title}</h3><dl>{rows.map(([k, v, n]) => <Fragment key={k}><dt>{k}</dt><dd className={n ? "num" : undefined}>{v ?? "—"}</dd></Fragment>)}</dl></div>;
}
export const phonesOf = (p: string[] | null | undefined) => (p && p.length ? p.join(" - ") : null);

export function OfficialSheet({ co, who, title, titleEn, pdfPath, status, boxes, children, final, rightLabel = "المحاسب", leftLabel, leftName = "", wide }: {
  co: Co | null; who: string | null; title: string; titleEn: string; pdfPath: string; status?: string; boxes?: ReactNode; children: ReactNode; final?: ReactNode; rightLabel?: string; leftLabel: string; leftName?: string; wide?: boolean;
}) {
  if (!co || who === null) return <Loading err="" />;
  const pdf = `/api/pdf?path=${encodeURIComponent(pdfPath)}`;
  return (<div className="print-root" dir="rtl">
    <div className="print-bar"><a href={pdf} target="_blank" rel="noreferrer"><button>🖨 طباعة (PDF رسمي A4)</button></a><a href={pdf} download>⬇ تنزيل PDF</a></div>
    <template id="pdf-footer" dangerouslySetInnerHTML={{ __html: footerHtml(co) }} />
    <div className="inv" data-ready="1">
      <div className="wm" aria-hidden="true"><img src="/brand/logo.webp" alt="" /><b>{co.name}</b>{co.nameEn && <i>{co.nameEn}</i>}</div>
      <div className="foot"><div><b>{co.name}</b>{co.nameEn && <> — <span className="en">{co.nameEn}</span></>}{co.address && <> — {co.address}</>}</div>
        {contactOf(co).length > 0 && <div className="row2">{contactOf(co).map((c) => <span key={c.k}>{c.k}: <span className="num">{c.v}</span></span>)}</div>}</div>
      <div className="content">
        <div className="head">
          <div className="brand"><img src="/brand/logo.webp" alt="شعار الشركة" /><div><div className="ar">{co.name}</div>{co.nameEn && <div className="enm en">{co.nameEn}</div>}</div></div>
          <div className="title"><b>{title}</b><small>{titleEn}</small></div>
        </div>
        {status && statusStamp(status) && <div className="stampbar">{statusStamp(status)}</div>}
        {boxes && <div className="boxes" style={wide ? { gridTemplateColumns: "1fr" } : undefined}>{boxes}</div>}
        {children}
        <div className="final">
          {final}
          <div className="sign">
            <div className="sigcol"><div className="who"><span>{rightLabel}</span><b>{who || " "}</b></div><img className="sig" src="/brand/signature.webp" alt="" /><img className="seal" src="/brand/stamp.webp" alt="ختم الشركة" /></div>
            <div className="sigcol"><div className="who"><span>{leftLabel}</span><b>{leftName || "\u00a0"}</b></div></div>
          </div>
        </div>
      </div>
    </div></div>);
}
