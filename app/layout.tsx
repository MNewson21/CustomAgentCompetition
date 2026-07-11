import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent Arena",
  description: "Multiple AI agents attempt the same task in parallel, scored live.",
};

// Fonts are loaded from Google Fonts at runtime with a graceful system fallback
// (see the token stacks in globals.css), so the app has no build-time font
// dependency and still renders correctly offline.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
