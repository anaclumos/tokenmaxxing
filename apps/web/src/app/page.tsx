import Link from "next/link";
import { Show, SignInButton, UserButton } from "@clerk/nextjs";
import { Button } from "@tokenmaxxing/ui/components/button";
import { Badge } from "@tokenmaxxing/ui/components/badge";

const CLIENTS = [
  "Claude Code", "Codex CLI", "Gemini CLI", "OpenCode", "AmpCode", "Cursor",
  "Roo Code", "KiloCode", "OpenClaw", "Pi-agent", "Kimi", "Qwen CLI",
  "Factory Droid", "Mux",
];

export default function Home() {
  return (
    <div className="flex flex-1 flex-col">
      {/* Nav */}
      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <span className="text-lg font-semibold font-mono tracking-tight">tokenmaxx.ing</span>
        <div className="flex items-center gap-3">
          <Link href="/leaderboard">
            <Button variant="ghost" size="sm">Leaderboard</Button>
          </Link>
          <Show when="signed-out">
            <SignInButton mode="modal">
              <Button size="sm">Sign in</Button>
            </SignInButton>
          </Show>
          <Show when="signed-in">
            <Link href="/dashboard">
              <Button variant="ghost" size="sm">Dashboard</Button>
            </Link>
            <UserButton />
          </Show>
        </div>
      </header>

      {/* Hero */}
      <main className="flex flex-1 flex-col items-center justify-center gap-8 px-6 py-24 text-center">
        <h1 className="max-w-2xl text-5xl font-bold tracking-tight">
          Compete on token consumption
        </h1>
        <p className="max-w-lg text-lg text-muted-foreground">
          Track your AI coding agent usage across all platforms.
          Join leaderboards. Flex your token count.
        </p>

        <div className="flex gap-3">
          <Show when="signed-out">
            <SignInButton mode="modal">
              <Button size="lg">Get started</Button>
            </SignInButton>
          </Show>
          <Show when="signed-in">
            <Link href="/dashboard">
              <Button size="lg">Dashboard</Button>
            </Link>
          </Show>
          <Link href="/leaderboard">
            <Button variant="outline" size="lg">View leaderboard</Button>
          </Link>
        </div>

        {/* How it works */}
        <div className="mt-16 grid max-w-3xl grid-cols-3 gap-8 text-left">
          <div>
            <div className="mb-2 font-mono text-sm text-muted-foreground">01</div>
            <h3 className="mb-1 font-semibold">Install the CLI</h3>
            <p className="text-sm text-muted-foreground">
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">bunx tokenmaxxing submit</code>
            </p>
          </div>
          <div>
            <div className="mb-2 font-mono text-sm text-muted-foreground">02</div>
            <h3 className="mb-1 font-semibold">Auto-detect agents</h3>
            <p className="text-sm text-muted-foreground">
              Parses local data from 14+ AI coding agents. No transcripts, only token counts.
            </p>
          </div>
          <div>
            <div className="mb-2 font-mono text-sm text-muted-foreground">03</div>
            <h3 className="mb-1 font-semibold">Climb the ranks</h3>
            <p className="text-sm text-muted-foreground">
              Global leaderboard or private org boards. See who burns the most tokens.
            </p>
          </div>
        </div>

        {/* Supported clients */}
        <div className="mt-12 flex flex-wrap justify-center gap-2">
          {CLIENTS.map((c) => (
            <Badge key={c} variant="secondary" className="font-mono text-xs">{c}</Badge>
          ))}
        </div>
      </main>
    </div>
  );
}
