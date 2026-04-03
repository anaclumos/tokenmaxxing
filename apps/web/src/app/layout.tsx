import { ClerkProvider } from "@clerk/nextjs";
import { dark } from "@clerk/themes";
import { cn } from "@tokenmaxxing/ui/lib/utils";
import type { Metadata } from "next";
import { Providers } from "@/components/providers";

import "@tokenmaxxing/ui/globals.css";
import localFont from "next/font/local";

const sunghyunSans = localFont({
  src: [
    { path: "../fonts/SunghyunSans-Thin.woff2", weight: "100" },
    { path: "../fonts/SunghyunSans-ExtraLight.woff2", weight: "200" },
    { path: "../fonts/SunghyunSans-Light.woff2", weight: "300" },
    { path: "../fonts/SunghyunSans-Regular.woff2", weight: "400" },
    { path: "../fonts/SunghyunSans-Medium.woff2", weight: "500" },
    { path: "../fonts/SunghyunSans-SemiBold.woff2", weight: "600" },
    { path: "../fonts/SunghyunSans-Bold.woff2", weight: "700" },
    { path: "../fonts/SunghyunSans-ExtraBold.woff2", weight: "800" },
    { path: "../fonts/SunghyunSans-Black.woff2", weight: "900" },
  ],
  variable: "--font-sunghyun-sans",
  display: "swap",
});

const iosevka = localFont({
  src: [
    { path: "../fonts/Iosevka-Regular.woff2", weight: "400" },
    { path: "../fonts/Iosevka-Medium.woff2", weight: "500" },
    { path: "../fonts/Iosevka-SemiBold.woff2", weight: "600" },
    { path: "../fonts/Iosevka-Bold.woff2", weight: "700" },
  ],
  variable: "--font-iosevka",
  display: "swap",
});

export const metadata: Metadata = {
  title: "tokenmaxx.ing",
  description: "Compete on token consumption across all AI coding agents",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider
      appearance={{
        baseTheme: dark,
      }}
    >
      <html
        lang="en"
        className={cn(
          "h-full antialiased",
          sunghyunSans.variable,
          iosevka.variable,
          "font-sans"
        )}
        suppressHydrationWarning
      >
        <body className="min-h-full flex flex-col">
          <Providers>{children}</Providers>
        </body>
      </html>
    </ClerkProvider>
  );
}
