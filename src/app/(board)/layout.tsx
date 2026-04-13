import { ClerkProvider } from "@clerk/nextjs";
import { Suspense } from "react";
import { BoardShell } from "@/components/board-shell";

const BYPASS = process.env.BYPASS_AUTH === "true";

export default function BoardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const content = BYPASS ? <BoardShell bypass>{children}</BoardShell> : (
    <ClerkProvider dynamic>
      <BoardShell bypass={false}>{children}</BoardShell>
    </ClerkProvider>
  );

  return (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Loading workspace...
        </div>
      }
    >
      {content}
    </Suspense>
  );
}
