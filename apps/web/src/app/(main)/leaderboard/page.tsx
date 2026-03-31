import { redirect } from "next/navigation";

export default function LeaderboardPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; page?: string }>;
}) {
  // Leaderboard is now the homepage
  return redirect("/");
}
