"use client";
import { useEffect, useState } from "react";
import { api, money } from "@/lib/client";

export interface Co { name: string; nameEn: string | null; address: string | null; phones: string[] | null; email?: string | null; website?: string | null; taxNo?: string | null; logoAttachmentId: string | null; signatureAttachmentId: string | null }

/** Loads a document + the company header, then sets data-ready so the PDF renderer knows the page is complete. */
export function usePrint<T>(path: string) {
  const [data, setData] = useState<T | null>(null); const [co, setCo] = useState<Co | null>(null); const [err, setErr] = useState("");
  useEffect(() => { Promise.all([api<T>(path), api<Co>("/api/company")]).then(([d, c]) => { setData(d); setCo(c); }).catch((e) => setErr(e.message)); }, [path]);
  return { data, co, err };
}

export function Sheet({ co, title, stamp, meta, children, pdfPath, footer, signer = ["المحاسب", "المستلم", "المدير"] }: { co: Co; title: string; stamp?: string; meta?: [string, string | null | undefined][]; children: React.ReactNode; pdfPath: string; footer?: React.ReactNode; signer?: string[] }) {
  return (
    <div className="print-root" dir="rtl">
      <div className="print-bar"><button onClick={() => window.print()}>🖨 طباعة</button><a href={`/api/pdf?path=${encodeURIComponent(pdfPath)}`}>⬇ تنزيل PDF (A4)</a></div>
      <div className="sheet" data-ready="1">
        <div className="co">{co.logoAttachmentId && <img src={`/api/attachments/${co.logoAttachmentId}`} alt="شعار" />}
          <div><div className="name">{co.name}</div>{co.nameEn && <small dir="ltr">{co.nameEn}</small>}{co.address && <small>{co.address}</small>}{co.phones && co.phones.length > 0 && <small className="num">{co.phones.join(" • ")}</small>}</div></div>
        <h1>{title}</h1>{stamp && <div className="stamp">{stamp}</div>}
        {meta && <div className="meta">{meta.filter(([, v]) => v).map(([k, v]) => <div key={k}><b>{k}:</b> <span className="num">{v}</span></div>)}</div>}
        {children}{footer}
        <div className="sign">{signer.map((s, i) => <div key={s}>{i === 0 && co.signatureAttachmentId && <img src={`/api/attachments/${co.signatureAttachmentId}`} alt="توقيع" />}{s}</div>)}</div>
      </div>
    </div>);
}
export const statusStamp = (s: string) => (s === "DRAFT" ? "مسودة — غير نهائي" : s === "REVERSED" ? "مُلغى (معكوس)" : s === "SENT" ? "" : "");
export const M = ({ v }: { v: string | number | null | undefined }) => <span className="num">{money(v)}</span>;
export function Loading({ err }: { err: string }) { return <div style={{ padding: 24 }}>{err || "جارٍ التحميل…"}</div>; }
