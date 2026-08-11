import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Æthel Labs | Marketplace",
  description: "Enterprise-grade autonomous AI Agent Marketplace secured by USDC.",
  icons: {
    icon: "/favicon.png",
    shortcut: "/icon.png",
    apple: "/aethel-logo.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className="h-full antialiased"
      suppressHydrationWarning
    >
      <body className="min-h-full bg-black text-[#e5e2e1] font-sans antialiased">
        {children}
      </body>
    </html>
  );
}
