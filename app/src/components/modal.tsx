"use client";
import { useEffect, useRef } from "react";

/** Small accessible dialog: Esc closes, click on the backdrop closes, focus goes to the first field and returns to the opener on close. Works on phones (full-width sheet). */
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  const box = useRef<HTMLDivElement>(null); const opener = useRef<Element | null>(null);
  useEffect(() => { opener.current = document.activeElement; box.current?.querySelector<HTMLElement>("input,select,textarea")?.focus(); return () => { (opener.current as HTMLElement | null)?.focus?.(); }; }, []);
  return (<div role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}
    style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", zIndex: 60, display: "grid", placeItems: "center", padding: 12 }}>
    <div ref={box} className="card" style={{ width: wide ? "min(720px, 100%)" : "min(480px, 100%)", maxHeight: "92vh", overflowY: "auto", display: "grid", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}><h2 style={{ margin: 0 }}>{title}</h2><button type="button" onClick={onClose} aria-label="إغلاق">✕</button></div>
      {children}</div></div>);
}
