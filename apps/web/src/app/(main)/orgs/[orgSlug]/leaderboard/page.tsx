"use client";

import { useOrganization } from "@clerk/nextjs";
import { formatTokens } from "@tokenmaxxing/shared/types";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@tokenmaxxing/ui/components/avatar";
import { Skeleton } from "@tokenmaxxing/ui/components/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@tokenmaxxing/ui/components/table";
import { Tabs, TabsList, TabsTrigger } from "@tokenmaxxing/ui/components/tabs";
import { useEffect, useState } from "react";

type Entry = {
  rank: number;
  username: string;
  avatarUrl: string | null;
  totalTokens: number;
  totalCost: string;
  compositeScore: string;
  streak: number;
};

export default function OrgLeaderboardPage() {
  const { organization } = useOrganization();
  const [period, setPeriod] = useState("alltime");
  const [data, setData] = useState<{ entries: Entry[]; total: number } | null>(
    null
  );

  useEffect(() => {
    if (!organization) return;
    fetch(`/api/leaderboard/${organization.id}?period=${period}`)
      .then((r) => r.json())
      .then(setData);
  }, [organization, period]);

  if (!organization)
    return (
      <p className="p-8 text-muted-foreground">Select an organization first.</p>
    );

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-8">
      <h1 className="mb-2 text-3xl font-bold tracking-tight">
        {organization.name}
      </h1>
      <p className="mb-6 text-muted-foreground">Org leaderboard</p>

      <Tabs
        value={period}
        onValueChange={(v: string) => setPeriod(v)}
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
            <TableHead className="text-right">Score</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {!data
            ? Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={5}>
                    <Skeleton className="h-4 w-full" />
                  </TableCell>
                </TableRow>
              ))
            : data.entries.map((e) => (
                <TableRow key={e.rank}>
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
                  <TableCell className="text-right font-mono">
                    {Number(e.compositeScore).toFixed(0)}
                  </TableCell>
                </TableRow>
              ))}
        </TableBody>
      </Table>
    </main>
  );
}
