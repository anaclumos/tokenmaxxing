import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { Button } from "@tokenmaxxing/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@tokenmaxxing/ui/components/card";
import { TokenManager } from "./token-manager";

export const metadata = { title: "Settings - tokenmaxx.ing" };

export default async function SettingsPage() {
  const { userId: clerkId } = await auth();
  if (!clerkId) redirect("/sign-in");

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <Link href="/" className="text-lg font-semibold font-mono tracking-tight">tokenmaxx.ing</Link>
        <div className="flex items-center gap-3">
          <Link href="/dashboard"><Button variant="ghost" size="sm">Dashboard</Button></Link>
          <UserButton />
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl px-6 py-8">
        <h1 className="mb-6 text-3xl font-bold tracking-tight">Settings</h1>

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
    </div>
  );
}
