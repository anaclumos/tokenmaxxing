"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@tokenmaxxing/ui/components/table";
import { Tabs, TabsList, TabsTrigger } from "@tokenmaxxing/ui/components/tabs";
import { Avatar, AvatarFallback, AvatarImage } from "@tokenmaxxing/ui/components/avatar";
import { Badge } from "@tokenmaxxing/ui/components/badge";
import { Skeleton } from "@tokenmaxxing/ui/components/skeleton";
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

function formatTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(n);
}

export function LeaderboardTable({ period, page }: { period: string; page: number }) {
  const router = useRouter();
  const [data, setData] = useState<{ entries: Entry[]; total: number } | null>(null);

  useEffect(() => {
    fetch(`/api/leaderboard?period=${period}&page=${page}`)
      .then((r) => r.json())
      .then(setData);
  }, [period, page]);

  return (
    <div>
      <Tabs
        value={period}
        onValueChange={(v: string) => router.push(`/leaderboard?period=${v}`)}
        className="mb-6"
      >
        <TabsList>
          <TabsTrigger value="daily">Daily</TabsTrigger>
          <TabsTrigger value="weekly">Weekly</TabsTrigger>
          <TabsTrigger value="monthly">Monthly</TabsTrigger>
          <TabsTrigger value="alltime">All Time</TabsTrigger>
        </TabsList>
      </Tabs>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-16">#</TableHead>
            <TableHead>User</TableHead>
            <TableHead className="text-right">Tokens</TableHead>
            <TableHead className="text-right">Cost</TableHead>
            <TableHead className="text-right">Streak</TableHead>
            <TableHead className="text-right">Score</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {!data
            ? Array.from({ length: 10 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell><Skeleton className="h-4 w-6" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-8" /></TableCell>
                  <TableCell><Skeleton className="h-4 w-12" /></TableCell>
                </TableRow>
              ))
            : data.entries.map((e) => (
                <TableRow key={e.rank}>
                  <TableCell className="font-mono text-muted-foreground">{e.rank}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Avatar className="h-6 w-6">
                        {e.avatarUrl && <AvatarImage src={e.avatarUrl} />}
                        <AvatarFallback className="text-xs">{e.username[0]}</AvatarFallback>
                      </Avatar>
                      <span className="font-medium">{e.username}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-mono">{formatTokens(e.totalTokens)}</TableCell>
                  <TableCell className="text-right font-mono">${Number(e.totalCost).toFixed(2)}</TableCell>
                  <TableCell className="text-right">
                    {e.streak > 0 && <Badge variant="secondary" className="font-mono text-xs">{e.streak}d</Badge>}
                  </TableCell>
                  <TableCell className="text-right font-mono">{Number(e.compositeScore).toFixed(0)}</TableCell>
                </TableRow>
              ))}
        </TableBody>
      </Table>

      {data && data.total > 50 && (
        <div className="mt-4 flex justify-center gap-2">
          {page > 1 && (
            <Link href={`/leaderboard?period=${period}&page=${page - 1}`}>
              <Badge variant="outline">Previous</Badge>
            </Link>
          )}
          <span className="text-sm text-muted-foreground">
            Page {page} of {Math.ceil(data.total / 50)}
          </span>
          {page * 50 < data.total && (
            <Link href={`/leaderboard?period=${period}&page=${page + 1}`}>
              <Badge variant="outline">Next</Badge>
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
