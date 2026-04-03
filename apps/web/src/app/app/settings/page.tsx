import { auth } from "@clerk/nextjs/server";
import { users } from "@tokenmaxxing/db/index";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@tokenmaxxing/ui/components/card";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { db } from "@/lib/db";

import { PrivacyToggle } from "./privacy-toggle";
import { TokenManager } from "./token-manager";

export const metadata = { title: "Settings - tokenmaxx.ing" };

export default async function SettingsPage() {
  const { userId: clerkId } = await auth();
  if (!clerkId) redirect("/sign-in");

  const [user] = await db()
    .select({ privacyMode: users.privacyMode })
    .from(users)
    .where(eq(users.clerkId, clerkId))
    .limit(1);

  if (!user) redirect("/sign-in");

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-8">
      <h1 className="mb-6 text-3xl font-bold tracking-tight">Settings</h1>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Privacy</CardTitle>
        </CardHeader>
        <CardContent>
          <PrivacyToggle initial={user.privacyMode} />
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>API Tokens</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-4 text-sm text-muted-foreground">
            Generate tokens to authenticate the CLI. Tokens are shown once and
            stored as hashes.
          </p>
          <TokenManager />
        </CardContent>
      </Card>
    </main>
  );
}
