import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  // Spans several pipelines now — no single division belongs in the tab title.
  title: "Miracle Makers · Enrollments Dashboard",
  description: "Live enrollment opportunities from GoHighLevel.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // 🔴 ROUND 177 · D10 — `data-rail` DECIDES THE SIDEBAR'S WIDTH, and it is
    // set here, before first paint, by the inline script below — the Next 16
    // guide's pattern for persisted UI state
    // (node_modules/next/dist/docs/01-app/02-guides/preventing-flash-before-hydration.md).
    // The server default is "collapsed"; the script reads `mm.rail` (the key in
    // lib/clientSidebar.ts — keep the two in step) and switches to "expanded"
    // only when somebody chose it and the screen is wider than 640px.
    // `suppressHydrationWarning` because the attribute may differ from what the
    // server sent, which is the point. ⚠️ try/catch: a third-party iframe can
    // have storage blocked, and then the default simply holds.
    <html lang="en" data-rail="collapsed" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html:
              '(function(){try{if(localStorage.getItem("mm.rail")==="expanded"&&!matchMedia("(max-width: 640px)").matches)document.documentElement.setAttribute("data-rail","expanded")}catch(e){}})()',
          }}
        />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
