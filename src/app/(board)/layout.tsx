import { Suspense } from "react";
import { Providers } from "@/components/providers";
import { BoardShell } from "@/components/board-shell";

export default function BoardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Loading workspace...
        </div>
      }
    >
      <Providers>
        <BoardShell>{children}</BoardShell>
      </Providers>
    </Suspense>
  );
}
