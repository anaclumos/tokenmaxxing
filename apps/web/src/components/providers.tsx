"use client";

import { ClerkProvider } from "@clerk/nextjs";
import { dark } from "@clerk/themes";
import { ThemeProvider, useTheme } from "next-themes";
import { useEffect } from "react";

function SuppressThemeScriptWarning() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;

    const original = console.error;
    console.error = (...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0].includes("Encountered a script tag")) {
        return;
      }

      original.apply(console, args);
    };

    return () => {
      console.error = original;
    };
  }, []);

  return null;
}

function ClerkThemed({ children }: { children: React.ReactNode }) {
  const { resolvedTheme } = useTheme();
  return (
    <ClerkProvider
      appearance={{
        baseTheme: resolvedTheme === "dark" ? dark : undefined,
      }}
    >
      {children}
    </ClerkProvider>
  );
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" disableTransitionOnChange>
      <SuppressThemeScriptWarning />
      <ClerkThemed>{children}</ClerkThemed>
    </ThemeProvider>
  );
}
