"use client";

import { formatTokens } from "@tokenmaxxing/shared/types";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@tokenmaxxing/ui/components/avatar";
import { Badge } from "@tokenmaxxing/ui/components/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@tokenmaxxing/ui/components/table";
import { Tabs, TabsList, TabsTrigger } from "@tokenmaxxing/ui/components/tabs";
import Link from "next/link";
import { useRouter } from "next/navigation";

type Entry = {
  rank: number;
  username: string;
  avatarUrl: string | null;
  totalTokens: number;
  totalCost: string;
  compositeScore: string;
  streak: number;
};

export function LeaderboardTable({
  entries,
  total,
  period,
  page,
  sort = "score",
}: {
  entries: Entry[];
  total: number;
  period: string;
  page: number;
  sort?: string;
}) {
  const router = useRouter();

  function nav(overrides: { period?: string; sort?: string; page?: number }) {
    const p = overrides.period ?? period;
    const s = overrides.sort ?? sort;
    const pg = overrides.page ?? 1;
    const params = new URLSearchParams({ period: p, sort: s });
    if (pg > 1) params.set("page", String(pg));
    router.push(`/?${params}`);
  }

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center gap-4">
        <Tabs value={period} onValueChange={(v) => nav({ period: v })}>
          <TabsList>
            <TabsTrigger value="daily">Daily</TabsTrigger>
            <TabsTrigger value="weekly">Weekly</TabsTrigger>
            <TabsTrigger value="monthly">Monthly</TabsTrigger>
            <TabsTrigger value="alltime">All Time</TabsTrigger>
          </TabsList>
        </Tabs>
        <Tabs value={sort} onValueChange={(v) => nav({ sort: v })}>
          <TabsList>
            <TabsTrigger value="score">Score</TabsTrigger>
            <TabsTrigger value="tokens">Tokens</TabsTrigger>
            <TabsTrigger value="cost">Cost</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className="overflow-x-auto">
        <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-16">#</TableHead>
            <TableHead>User</TableHead>
            <TableHead className="text-right">Tokens</TableHead>
            <TableHead className="text-right">Cost</TableHead>
            <TableHead className="hidden text-right sm:table-cell">Streak</TableHead>
            <TableHead className="hidden text-right sm:table-cell">Score</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map((e) => (
            <TableRow
              key={e.rank}
              className="cursor-pointer"
              onClick={() => router.push(`/u/${e.username}`)}
            >
              <TableCell className="font-mono text-muted-foreground">
                {e.rank}
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <Avatar className="h-6 w-6">
                    {e.avatarUrl && <AvatarImage src={e.avatarUrl} />}
                    <AvatarFallback className="text-xs">
                      {e.username[0]}
                    </AvatarFallback>
                  </Avatar>
                  <span className="font-medium">{e.username}</span>
                </div>
              </TableCell>
              <TableCell className="text-right font-mono">
                {formatTokens(e.totalTokens)}
              </TableCell>
              <TableCell className="text-right font-mono">
                ${Number(e.totalCost).toFixed(2)}
              </TableCell>
              <TableCell className="hidden text-right sm:table-cell">
                {e.streak > 0 && (
                  <Badge variant="secondary" className="font-mono text-xs">
                    {e.streak}d
                  </Badge>
                )}
              </TableCell>
              <TableCell className="hidden text-right font-mono sm:table-cell">
                {Number(e.compositeScore).toFixed(0)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
        </Table>
      </div>

      {total > 50 && (
        <div className="mt-4 flex justify-center gap-2">
          {page > 1 && (
            <Link href={`/?period=${period}&sort=${sort}&page=${page - 1}`}>
              <Badge variant="outline">Previous</Badge>
            </Link>
          )}
          <span className="text-sm text-muted-foreground">
            Page {page} of {Math.ceil(total / 50)}
          </span>
          {page * 50 < total && (
            <Link href={`/?period=${period}&sort=${sort}&page=${page + 1}`}>
              <Badge variant="outline">Next</Badge>
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
