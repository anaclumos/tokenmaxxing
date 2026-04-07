import { auth, clerkClient } from "@clerk/nextjs/server";
import { budgetAlerts, users } from "@tokenmaxxing/db/index";
import { Card, CardContent, CardHeader, CardTitle } from "@tokenmaxxing/ui/components/card";
import { buttonVariants } from "@tokenmaxxing/ui/components/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@tokenmaxxing/ui/components/table";
import { cn } from "@tokenmaxxing/ui/lib/utils";
import { desc, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { db } from "@/lib/db";

import { BudgetThresholdForm } from "./budget-threshold-form";

export const metadata = { title: "Budget Thresholds - tokenmaxx.ing" };

export default async function OrgBudgetSettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const [{ orgSlug }, { userId, orgId, orgSlug: activeSlug, has }] = await Promise.all([
    params,
    auth(),
  ]);

  if (!userId) redirect("/sign-in");
  if (!orgId || activeSlug !== orgSlug || !has({ role: "org:admin" })) notFound();

  const client = await clerkClient();
  const [org, memberships] = await Promise.all([
    client.organizations.getOrganization({ organizationId: orgId }),
    client.organizations.getOrganizationMembershipList({
      organizationId: orgId,
      limit: 500,
    }),
  ]);

  const clerkIds = memberships.data
    .map((member) => member.publicUserData?.userId)
    .filter((id): id is string => Boolean(id));
  const members =
    clerkIds.length > 0
      ? await db()
          .select({
            id: users.id,
            username: users.username,
            clerkId: users.clerkId,
          })
          .from(users)
          .where(inArray(users.clerkId, clerkIds))
      : [];
  const alerts = await db()
    .select({
      id: budgetAlerts.id,
      userId: budgetAlerts.userId,
      period: budgetAlerts.period,
      thresholdUsd: budgetAlerts.thresholdUsd,
      webhookUrl: budgetAlerts.webhookUrl,
      emailNotify: budgetAlerts.emailNotify,
      updatedAt: budgetAlerts.updatedAt,
    })
    .from(budgetAlerts)
    .where(eq(budgetAlerts.orgId, orgId))
    .orderBy(desc(budgetAlerts.updatedAt));

  const memberMap = new Map(members.map((member) => [member.id, member.username]));
  const rows = alerts
    .map((alert) => ({
      ...alert,
      thresholdUsd: Number(alert.thresholdUsd),
      username: alert.userId ? (memberMap.get(alert.userId) ?? "Unknown") : "Org-wide",
    }))
    .toSorted((a, b) => {
      if (a.userId === null && b.userId !== null) return -1;
      if (a.userId !== null && b.userId === null) return 1;
      if (a.username !== b.username) return a.username.localeCompare(b.username);
      return a.period.localeCompare(b.period);
    });

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{org.name}</h1>
          <p className="text-muted-foreground">Budget thresholds</p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Link
            href={`/app/orgs/${orgSlug}/leaderboard`}
            className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
          >
            Leaderboard
          </Link>
          <Link
            href={`/app/orgs/${orgSlug}/analytics`}
            className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
          >
            Analytics
          </Link>
        </div>
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Create or replace threshold</CardTitle>
        </CardHeader>
        <CardContent>
          <BudgetThresholdForm
            orgId={orgId}
            members={members
              .map((member) => ({
                id: member.id,
                username: member.username,
              }))
              .toSorted((a, b) => a.username.localeCompare(b.username))}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Current thresholds</CardTitle>
        </CardHeader>
        <CardContent>
          {rows.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Scope</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead className="text-right">Threshold</TableHead>
                  <TableHead>Delivery</TableHead>
                  <TableHead>Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-medium">{row.username}</TableCell>
                    <TableCell className="font-mono">{row.period}</TableCell>
                    <TableCell className="text-right font-mono">
                      ${row.thresholdUsd.toFixed(2)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.webhookUrl && row.emailNotify
                        ? "Webhook + email"
                        : row.webhookUrl
                          ? "Webhook"
                          : row.emailNotify
                            ? "Email"
                            : "None"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.updatedAt.toLocaleDateString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">
              No budget thresholds yet. Save one above to add an org-wide or per-member limit.
            </p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
