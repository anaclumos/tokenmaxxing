import { Suspense } from "react";
import { Providers } from "@/components/providers";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-full items-center justify-center text-sm text-muted-foreground">
          Loading authentication...
        </div>
      }
    >
      <Providers>
        <div className="flex min-h-full flex-col items-center justify-center bg-background">
          {children}
        </div>
      </Providers>
    </Suspense>
  );
}
