import { cn } from "@tokenmaxxing/ui/lib/utils"
import Link from "next/link"

export default function CallToAction() {
  return (
    <section className="py-24">
      <div className="mx-auto max-w-6xl px-4">
        <div
          className={cn(
            "overflow-hidden rounded-2xl border",
            "border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900",
          )}
        >
          <div className="grid sm:grid-cols-6">
            {/* Text side */}
            <div className="flex flex-col justify-center gap-6 p-10 sm:col-span-2">
              <div className="flex flex-col gap-3">
                <h2 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-gray-50">
                  Ready to start tracking?
                </h2>
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  Install the CLI and submit your first usage in under a minute.
                </p>
              </div>

              <div className="flex flex-col gap-3">
                <Link
                  href="/sign-up"
                  className={cn(
                    "inline-flex items-center justify-center rounded-md px-4 py-2.5 text-sm font-semibold text-white",
                    "bg-linear-to-b from-emerald-400 to-emerald-500",
                    "border-b-2 border-emerald-700",
                    "shadow-sm hover:shadow-md transition-shadow",
                  )}
                >
                  Get Started
                </Link>
                <Link
                  href="/leaderboard"
                  className={cn(
                    "inline-flex items-center justify-center rounded-md px-4 py-2.5 text-sm font-medium",
                    "border border-gray-200 bg-white text-gray-700 hover:bg-gray-50",
                    "dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700",
                    "transition-colors",
                  )}
                >
                  View Leaderboard
                </Link>
              </div>
            </div>

            {/* Code block side */}
            <div
              className={cn(
                "flex items-center justify-center p-8 sm:col-span-4",
                "bg-gray-950 dark:bg-black",
              )}
            >
              <div className="w-full max-w-sm">
                {/* Terminal chrome */}
                <div className="flex items-center gap-1.5 pb-4">
                  <span className="size-3 rounded-full bg-red-500" />
                  <span className="size-3 rounded-full bg-yellow-500" />
                  <span className="size-3 rounded-full bg-green-500" />
                </div>

                {/* Terminal content */}
                <div className="font-mono text-sm">
                  <span className="text-gray-500">$ </span>
                  <span className="text-green-400">bunx tokenmaxxing submit</span>
                </div>

                <div className="mt-3 space-y-1 font-mono text-xs text-gray-400">
                  <p>Scanning for Claude Code sessions...</p>
                  <p>Found 42 sessions (128K tokens)</p>
                  <p className="text-green-400">Submitted successfully!</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
