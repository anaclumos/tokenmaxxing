"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
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
import { formatTokens } from "@tokenmaxxing/shared/types";

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
}: {
  entries: Entry[];
  total: number;
  period: string;
  page: number;
}) {
  const router = useRouter();

  return (
    <div>
      <Tabs
        value={period}
        onValueChange={(v) => router.push(`/?period=${v}`)}
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
          {entries.map((e) => (
            <TableRow key={e.rank} className="cursor-pointer" onClick={() => router.push(`/u/${e.username}`)}>
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

      {total > 50 && (
        <div className="mt-4 flex justify-center gap-2">
          {page > 1 && (
            <Link href={`/?period=${period}&page=${page - 1}`}>
              <Badge variant="outline">Previous</Badge>
            </Link>
          )}
          <span className="text-sm text-muted-foreground">
            Page {page} of {Math.ceil(total / 50)}
          </span>
          {page * 50 < total && (
            <Link href={`/?period=${period}&page=${page + 1}`}>
              <Badge variant="outline">Next</Badge>
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
