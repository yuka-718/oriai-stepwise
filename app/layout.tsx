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
    "プロンプトと参考画像から、折り紙の展開図と完成形3Dモデルを表示する研究プロトタイプ。",
  authors: [{ name: "伊藤夕夏" }],
  alternates: { canonical: publicUrl },
  openGraph: {
    type: "website",
    locale: "ja_JP",
    url: publicUrl,
    siteName: "ORIAI",
    title: "ORIAI — 展開図と完成形3Dを生成",
    description: "プロンプトと参考画像を入力して、折り紙の展開図と完成形3Dモデルを表示します。",
    images: [{ url: "og-oriai-vivid.png", width: 1732, height: 908, alt: "ORIAI 折り紙生成プロトタイプ" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "ORIAI — 展開図と完成形3Dを生成",
    description: "プロンプトと参考画像を入力して、折り紙の展開図と完成形3Dモデルを表示します。",
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
