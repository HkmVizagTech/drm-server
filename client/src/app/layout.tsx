import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/lib/auth-context";

// display: "swap" so a slow connection in the office shows the fallback
// immediately rather than a blank screen. Until globals.css mapped these
// variables into the theme, both fonts were downloaded on every page load and
// neither one ever rendered - the body rule set system-ui over the top.
const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"], display: "swap" });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  title: "HKM Vizag Management",
  description: "Centralized management system for HKM Vizag",
};

// themeColor belongs in the viewport export, not metadata - this version of
// Next warns on every route if it is in the wrong one. The browser paints the
// address bar and mobile chrome from it, so a phone showing the calling
// screens frames them in the temple's green rather than default grey.
export const viewport: Viewport = {
  themeColor: "#2b6e2f",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
