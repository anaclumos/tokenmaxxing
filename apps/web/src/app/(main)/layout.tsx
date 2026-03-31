import Link from "next/link";
import { Show, UserButton } from "@clerk/nextjs";
import { Button } from "@tokenmaxxing/ui/components/button";

export default function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <Link href="/" className="text-lg font-semibold font-mono tracking-tight">
          tokenmaxx.ing
        </Link>
        <div className="flex items-center gap-3">
          <Link href="/leaderboard">
            <Button variant="ghost" size="sm">Leaderboard</Button>
          </Link>
          <Show when="signed-in">
            <Link href="/dashboard">
              <Button variant="ghost" size="sm">Dashboard</Button>
            </Link>
            <UserButton />
          </Show>
        </div>
      </header>
      {children}
    </div>
  );
}
