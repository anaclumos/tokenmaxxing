import { Show, SignInButton, UserButton } from "@clerk/nextjs";
import { Button } from "@tokenmaxxing/ui/components/button";
import Link from "next/link";

export default function MainLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <Link
          href="/"
          className="text-lg font-semibold font-mono tracking-tight"
        >
          tokenmaxx.ing
        </Link>
        <div className="flex items-center gap-3">
          <Link href="/docs">
            <Button variant="ghost" size="sm">
              API
            </Button>
          </Link>
          <Show when="signed-out">
            <SignInButton mode="modal">
              <Button size="sm">Sign in</Button>
            </SignInButton>
          </Show>
          <Show when="signed-in">
            <Link href="/dashboard">
              <Button variant="ghost" size="sm">
                Dashboard
              </Button>
            </Link>
            <UserButton />
          </Show>
        </div>
      </header>
      {children}
    </div>
  );
}
