"use client";

import { useEffect, useState } from "react";
import { useOrganization } from "@clerk/nextjs";
import { Card, CardContent, CardHeader, CardTitle } from "@tokenmaxxing/ui/components/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@tokenmaxxing/ui/components/table";
import { Tabs, TabsList, TabsTrigger } from "@tokenmaxxing/ui/components/tabs";
import { Skeleton } from "@tokenmaxxing/ui/components/skeleton";
import { formatTokens } from "@tokenmaxxing/shared/types";

type Analytics = {
  total: { tokens: number; cost: number };
  members: Array<{ username: string; tokens: number; cost: number; sessions: number }>;
  days: number;
};

export default function OrgAnalyticsPage() {
  const { organization } = useOrganization();
  const [days, setDays] = useState("30");
  const [data, setData] = useState<Analytics | null>(null);

  useEffect(() => {
    if (!organization) return;
    setData(null);
    fetch(`/api/org-analytics/${organization.id}?days=${days}`)
      .then((r) => r.json())
      .then(setData);
  }, [organization, days]);

  if (!organization) return <p className="p-8 text-muted-foreground">Select an organization first.</p>;

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-8">
      <h1 className="mb-2 text-3xl font-bold tracking-tight">{organization.name}</h1>
      <p className="mb-6 text-muted-foreground">Team analytics</p>

      <Tabs value={days} onValueChange={setDays} className="mb-6">
        <TabsList>
          <TabsTrigger value="7">7 days</TabsTrigger>
          <TabsTrigger value="30">30 days</TabsTrigger>
          <TabsTrigger value="90">90 days</TabsTrigger>
          <TabsTrigger value="365">All time</TabsTrigger>
        </TabsList>
      </Tabs>

      {!data ? (
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-24 w-full" />)}
        </div>
      ) : (
        <>
          {/* Totals */}
          <div className="mb-8 grid grid-cols-2 gap-4">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Total Tokens</CardTitle></CardHeader>
              <CardContent><span className="text-2xl font-bold font-mono">{formatTokens(data.total.tokens)}</span></CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Total Cost</CardTitle></CardHeader>
              <CardContent><span className="text-2xl font-bold font-mono">${data.total.cost.toFixed(2)}</span></CardContent>
            </Card>
          </div>

          {/* Per-member */}
          <h2 className="mb-3 text-lg font-semibold">By Member</h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="text-right">Sessions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.members.map((m) => (
                <TableRow key={m.username}>
                  <TableCell className="font-medium">{m.username}</TableCell>
                  <TableCell className="text-right font-mono">{formatTokens(m.tokens)}</TableCell>
                  <TableCell className="text-right font-mono">${m.cost.toFixed(2)}</TableCell>
                  <TableCell className="text-right text-muted-foreground">{m.sessions}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

        </>
      )}
    </main>
  );
}
