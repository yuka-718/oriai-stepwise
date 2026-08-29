import type { Metadata, Viewport } from "next";
import "./globals.css";

const configuredPublicUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim();
const publicUrl = configuredPublicUrl
  ? `${configuredPublicUrl.replace(/\/+$/, "")}/`
  : "https://yuka-718.github.io/oriai-stepwise/";

export const metadata: Metadata = {
  metadataBase: new URL(publicUrl),
  title: "ORIAI — 折り紙生成プロトタイプ",
  description:
    "Codexが折り線を一手ずつ提案し、Orieditaの2D平坦折りで検証する折り紙生成プロトタイプ。",
  authors: [{ name: "伊藤夕夏" }],
  alternates: { canonical: publicUrl },
  openGraph: {
    type: "website",
    locale: "ja_JP",
    url: publicUrl,
    siteName: "ORIAI",
    title: "ORIAI — 折り線を一手ずつ生成・検証",
    description: "Codexが折り線を一手ずつ提案し、Orieditaの2D平坦折りで検証。同じ展開図の形状プレビューを表示します。",
    images: [{ url: "og-oriai-vivid.png", width: 1732, height: 908, alt: "ORIAI 折り紙生成プロトタイプ" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "ORIAI — 折り線を一手ずつ生成・検証",
    description: "Codexが折り線を一手ずつ提案し、Orieditaの2D平坦折りで検証。同じ展開図の形状プレビューを表示します。",
    images: ["og-oriai-vivid.png"],
  },
};

export const viewport: Viewport = {
  themeColor: "#2457ff",
  colorScheme: "light",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
