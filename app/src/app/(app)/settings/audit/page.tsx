"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";

interface Row { id: number; occurredAt: string; user: string | null; action: string; entityType: string; before: unknown; after: unknown }
export default function Audit() {
  const [rows, setRows] = useState<Row[]>([]); const [err, setErr] = useState("");
  useEffect(() => { api<Row[]>("/api/audit?limit=200").then(setRows).catch((e) => setErr(e.message)); }, []);
  return (<><h1>سجل التدقيق</h1>{err && <div className="msg err">{err}</div>}
    <div className="card cards-as-list"><table><thead><tr><th>الوقت</th><th>المستخدم</th><th>العملية</th><th>الكيان</th></tr></thead>
      <tbody>{rows.map((r) => <tr key={r.id}><td><span className="num">{new Date(r.occurredAt).toLocaleString("en-GB")}</span></td><td><span className="num">{r.user ?? "—"}</span></td><td><span className="num">{r.action}</span></td><td>{r.entityType}</td></tr>)}</tbody></table></div></>);
}
