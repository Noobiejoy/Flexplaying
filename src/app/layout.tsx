import type { Metadata } from "next";
import { Archivo } from "next/font/google";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import "./globals.css";

const archivo = Archivo({ subsets: ["latin"], variable: "--font-archivo", display: "swap", axes: ["wdth"] });

export const metadata: Metadata = {
  title: process.env.NEXT_PUBLIC_PRODUCT_NAME ?? "EditorialOS",
  description: "Autonomous editorial desk for anime, gaming and esports publishing",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // The init script may set data-theme before React hydrates.
    <html lang="en" className={archivo.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="font-sans text-ink">{children}</body>
    </html>
  );
}
