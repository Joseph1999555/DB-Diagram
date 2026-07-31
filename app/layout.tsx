import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "@xyflow/react/dist/style.css";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "relix.local";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.includes("localhost") ? "http" : "https");
  let origin: URL;
  try {
    origin = new URL(`${protocol}://${host}`);
  } catch {
    origin = new URL("https://relix.local");
  }
  const socialImage = new URL("/og.png", origin).toString();

  return {
    metadataBase: origin,
    title: "Relix — Database diagrams, at the speed of thought",
    description:
      "A collaborative, DBML-first workspace for designing and exploring relational databases.",
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
    },
    openGraph: {
      title: "Relix — Collaborative database design",
      description:
        "Write DBML, map relationships, and explore complex schemas together.",
      type: "website",
      images: [{ url: socialImage, width: 1536, height: 1024, alt: "Relix database diagram workspace" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Relix — Collaborative database design",
      description:
        "Write DBML, map relationships, and explore complex schemas together.",
      images: [socialImage],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
