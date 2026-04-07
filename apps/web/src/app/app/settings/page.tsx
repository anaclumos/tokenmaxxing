import { Card, CardContent, CardHeader, CardTitle } from "@tokenmaxxing/ui/components/card";
import { redirect } from "next/navigation";

import { getCurrentDbUser } from "@/lib/current-user";

import { PrivacyToggle } from "./privacy-toggle";
import { TokenManager } from "./token-manager";
import { WeeklyDigestToggle } from "./weekly-digest-toggle";

export const metadata = { title: "Settings - tokenmaxx.ing" };

export default async function SettingsPage() {
  const { user } = await getCurrentDbUser();

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
          <CardTitle>Weekly Digest</CardTitle>
        </CardHeader>
        <CardContent>
          <WeeklyDigestToggle initial={user.weeklyDigestEnabled} />
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>API Tokens</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-4 text-sm text-muted-foreground">
            Generate tokens to authenticate the CLI. Tokens are shown once and stored as hashes.
          </p>
          <TokenManager />
        </CardContent>
      </Card>
    </main>
  );
}
