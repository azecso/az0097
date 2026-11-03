// Amount in Arabic words (integers up to 999,999,999,999) for vouchers: "فقط ... دينار عراقي لا غير".
const ones = ["", "واحد", "اثنان", "ثلاثة", "أربعة", "خمسة", "ستة", "سبعة", "ثمانية", "تسعة", "عشرة", "أحد عشر", "اثنا عشر", "ثلاثة عشر", "أربعة عشر", "خمسة عشر", "ستة عشر", "سبعة عشر", "ثمانية عشر", "تسعة عشر"];
const tens = ["", "", "عشرون", "ثلاثون", "أربعون", "خمسون", "ستون", "سبعون", "ثمانون", "تسعون"];
const hundreds = ["", "مائة", "مائتان", "ثلاثمائة", "أربعمائة", "خمسمائة", "ستمائة", "سبعمائة", "ثمانمائة", "تسعمائة"];
function below1000(n: number): string {
  const parts: string[] = []; const h = Math.floor(n / 100), r = n % 100;
  if (h) parts.push(hundreds[h]!);
  if (r) { if (r < 20) parts.push(ones[r]!); else { const o = r % 10, t = Math.floor(r / 10); parts.push(o ? `${ones[o]} و${tens[t]}` : tens[t]!); } }
  return parts.join(" و");
}
const scales: [number, string, string, string][] = [[1e9, "مليار", "ملياران", "مليارات"], [1e6, "مليون", "مليونان", "ملايين"], [1e3, "ألف", "ألفان", "آلاف"]];
export function tafqeet(n: number, unit = "دينار عراقي"): string {
  n = Math.floor(Math.abs(n)); if (n === 0) return `صفر ${unit} لا غير`;
  const out: string[] = []; let rest = n;
  for (const [v, one, two, many] of scales) {
    const q = Math.floor(rest / v); if (!q) continue; rest %= v;
    out.push(q === 1 ? one : q === 2 ? two : q <= 10 ? `${below1000(q)} ${many}` : `${below1000(q)} ${one}`);
  }
  if (rest) out.push(below1000(rest));
  return `فقط ${out.join(" و")} ${unit} لا غير`;
}
