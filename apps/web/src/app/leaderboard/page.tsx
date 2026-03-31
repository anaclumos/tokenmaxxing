import Link from "next/link";
import { Button } from "@tokenmaxxing/ui/components/button";
import { LeaderboardTable } from "./leaderboard-table";

export const metadata = { title: "Leaderboard - tokenmaxx.ing" };

export default async function LeaderboardPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; page?: string }>;
}) {
  const params = await searchParams;
  const period = params.period ?? "alltime";
  const page = Number(params.page ?? 1);

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <Link href="/" className="text-lg font-semibold font-mono tracking-tight">
          tokenmaxx.ing
        </Link>
        <Link href="/leaderboard">
          <Button variant="ghost" size="sm">Leaderboard</Button>
        </Link>
      </header>

      <main className="mx-auto w-full max-w-4xl px-6 py-8">
        <h1 className="mb-6 text-3xl font-bold tracking-tight">Leaderboard</h1>
        <LeaderboardTable period={period} page={page} />
      </main>
    </div>
  );
}
