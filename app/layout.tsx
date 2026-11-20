import type { Metadata } from "next";
import "./globals.css";
import { uiFontHref, uiFontStack } from "@/lib/font";

export const metadata: Metadata = {

  title: "Miracle Makers · Enrollments Dashboard",
  description: "Live enrollment opportunities from GoHighLevel.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (

    <html
      lang="en"
      data-rail="expanded"
      suppressHydrationWarning
      style={{ ["--font" as string]: uiFontStack() } as React.CSSProperties}
    >
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html:
              '(function(){var c=false;try{c=localStorage.getItem("mm.rail")==="collapsed"}catch(e){}if(c||matchMedia("(max-width: 640px)").matches)document.documentElement.setAttribute("data-rail","collapsed")})()',
          }}
        />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />

        <link href={uiFontHref()} rel="stylesheet" />
      </head>
      <body>{children}</body>
    </html>
  );
}
