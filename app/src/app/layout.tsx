import type { Metadata, Viewport } from "next";
import "@fontsource/cairo/arabic-400.css";
import "@fontsource/cairo/arabic-700.css";
import "@fontsource/cairo/latin-400.css";
import "@fontsource/cairo/latin-700.css";
import "./globals.css";

export const metadata: Metadata = { title: "النظام المحاسبي", description: "نظام محاسبة ومخزون وشراكة" };
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#1a7f4b" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (<html lang="ar" dir="rtl"><body>{children}</body></html>);
}
