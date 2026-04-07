"use client";

import { ClerkProvider } from "@clerk/nextjs";
import { dark } from "@clerk/themes";
import { ThemeProvider, useTheme } from "next-themes";
import { useEffect, useRef } from "react";

let originalConsoleError: typeof console.error | null = null;
let suppressionCount = 0;

function acquireThemeScriptWarningSuppression() {
  if (process.env.NODE_ENV !== "development") return;
  if (originalConsoleError === null) {
    originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0].includes("Encountered a script tag")) {
        return;
      }

      originalConsoleError?.apply(console, args);
    };
  }

  suppressionCount += 1;
}

function releaseThemeScriptWarningSuppression() {
  if (process.env.NODE_ENV !== "development") return;
  suppressionCount -= 1;

  if (suppressionCount <= 0 && originalConsoleError) {
    console.error = originalConsoleError;
    originalConsoleError = null;
    suppressionCount = 0;
  }
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
  const patched = useRef(false);

  if (!patched.current) {
    acquireThemeScriptWarningSuppression();
    patched.current = true;
  }

  useEffect(() => {
    return () => {
      if (patched.current) {
        releaseThemeScriptWarningSuppression();
        patched.current = false;
      }
    };
  }, []);

  return (
    <ThemeProvider attribute="class" defaultTheme="system" disableTransitionOnChange>
      <ClerkThemed>{children}</ClerkThemed>
    </ThemeProvider>
  );
}
