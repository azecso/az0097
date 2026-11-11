"use client";
import { useEffect, useRef, useState } from "react";
import { api, money } from "@/lib/client";

interface Check { rate: string | null; per100: string | null; source: string | null; stored: { rate: string; rateDate: string; ageDays: number } | null; warnings: string[] }
const W: Record<string, string> = {
  NO_STORED_RATE: "لا يوجد سعر صرف مسجّل لهذا التاريخ؛ أدخل السعر يدوياً أو سجّل سعر اليوم.",
  STALE_RATE: "آخر سعر مسجّل قديم (أكثر من 3 أيام). تأكد من السعر قبل المتابعة.",
  BIG_CHANGE: "السعر يختلف عن آخر سعر مسجّل بأكثر من 5%؛ راجع إدخالك (مثلاً 1480 وليس 148).",
};
/** Rate input with a live check: what 100 USD is in dinars, the stored rate's age, and a warning on stale or far-off rates. Advisory only: the typed rate is never altered. */
export function FxRateField({ id = "r", name = "rate", label = "سعر الصرف (دينار لكل 1$ — فارغ = سعر اليوم)", defaultValue = "" }: { id?: string; name?: string; label?: string; defaultValue?: string }) {
  const ref = useRef<HTMLInputElement>(null); const [info, setInfo] = useState<Check | null>(null), [val, setVal] = useState(defaultValue);
  useEffect(() => {
    const form = ref.current?.closest("form"); const dateEl = form?.querySelector<HTMLInputElement>('input[type="date"]');
    const run = () => { const date = dateEl?.value || new Date().toISOString().slice(0, 10); api<Check>(`/api/fx-rates/check?currency=USD&date=${date}${val ? `&rate=${encodeURIComponent(val)}` : ""}`).then(setInfo).catch(() => setInfo(null)); };
    run(); dateEl?.addEventListener("change", run); return () => dateEl?.removeEventListener("change", run);
  }, [val]);
  return (<div><label htmlFor={id}>{label}</label><input id={id} name={name} ref={ref} inputMode="decimal" dir="ltr" value={val} onChange={(e) => setVal(e.target.value)} />
    {info?.rate && <small role="status">100$ = <b className="num">{money(info.per100 ?? "0")}</b> د.ع {info.source === "daily" && info.stored ? `(سعر ${info.stored.rateDate})` : ""}</small>}
    {info?.warnings.map((w) => <div key={w} className="msg err" role="alert">{W[w]}</div>)}</div>);
}
