import { ClerkProvider } from "@clerk/nextjs";
import { Suspense } from "react";

const BYPASS = process.env.BYPASS_AUTH === "true";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  const content = BYPASS ? children : <ClerkProvider dynamic>{children}</ClerkProvider>;

  return (
    <Suspense
      fallback={
        <div className="flex min-h-full items-center justify-center text-sm text-muted-foreground">
          Loading authentication...
        </div>
      }
    >
      <div className="flex min-h-full flex-col items-center justify-center bg-background">
        {content}
      </div>
    </Suspense>
  );
}
