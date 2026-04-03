"use client"

import { cn } from "@tokenmaxxing/ui/lib/utils"

import { FadeContainer, FadeDiv } from "@/components/marketing/Fade"

const agentBadges = [
  "claude-code",
  "codex",
  "gemini-cli",
  "cursor",
  "roo-code",
  "copilot",
  "aider",
  "continue",
  "cline",
]

function AgentGrid() {
  return (
    <div className="flex flex-wrap gap-2 p-6">
      {agentBadges.map((name) => (
        <span
          key={name}
          className={cn(
            "rounded-md border px-3 py-1 font-mono text-xs",
            "border-gray-200 bg-gray-50 text-gray-700",
            "dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300",
          )}
        >
          {name}
        </span>
      ))}
    </div>
  )
}

const mockRanks = [
  { rank: 1, user: "power_user", tokens: "4.2B" },
  { rank: 2, user: "token_hoarder", tokens: "3.8B" },
  { rank: 3, user: "ai_enjoyer", tokens: "2.1B" },
]

function RankMockup() {
  return (
    <div className="divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white p-2 dark:divide-gray-800 dark:border-gray-700 dark:bg-gray-900">
      {mockRanks.map(({ rank, user, tokens }) => (
        <div key={rank} className="flex items-center gap-3 px-3 py-2">
          <span
            className={cn(
              "w-6 text-center text-sm font-bold",
              rank === 1
                ? "text-emerald-500"
                : rank === 2
                  ? "text-gray-400"
                  : "text-emerald-700",
            )}
          >
            #{rank}
          </span>
          <span className="flex-1 text-sm text-gray-700 dark:text-gray-300">
            {user}
          </span>
          <span className="font-mono text-sm text-gray-500 dark:text-gray-400">
            {tokens}
          </span>
        </div>
      ))}
    </div>
  )
}

function StatsMockup() {
  return (
    <div className="grid grid-cols-2 gap-3 p-2">
      {[
        { label: "Cache hit rate", value: "74%" },
        { label: "Avg session tokens", value: "128K" },
        { label: "Models used", value: "6" },
        { label: "Active streak", value: "12 days" },
      ].map(({ label, value }) => (
        <div
          key={label}
          className={cn(
            "rounded-lg border p-3",
            "border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800",
          )}
        >
          <p className="text-xs text-gray-500 dark:text-gray-400">{label}</p>
          <p className="mt-0.5 text-lg font-semibold text-gray-900 dark:text-gray-50">
            {value}
          </p>
        </div>
      ))}
    </div>
  )
}

const features = [
  {
    subtitle: "Track",
    title: "Submit usage from 14+ AI coding agents",
    description:
      "Support for Claude Code, Codex, Gemini CLI, Cursor, Roo Code, and more. One command to submit all your usage.",
    visual: <AgentGrid />,
  },
  {
    subtitle: "Compete",
    title: "Climb the global leaderboard",
    description:
      "Composite scoring based on token volume, efficiency, session count, and streaks. Filter by client or model.",
    visual: <RankMockup />,
  },
  {
    subtitle: "Analyze",
    title: "Deep insights into your usage",
    description:
      "Activity heatmaps, cost projections, cache efficiency tracking, model breakdowns, and per-project analytics.",
    visual: <StatsMockup />,
  },
]

export default function Features() {
  return (
    <section className="py-24">
      <div className="mx-auto max-w-6xl px-4">
        <FadeContainer className="flex flex-col gap-24">
          {features.map((feature, i) => (
            <FadeDiv key={feature.subtitle}>
              <div
                className={cn(
                  "grid items-center gap-12 md:grid-cols-2",
                  i % 2 !== 0 && "md:[&>*:first-child]:order-last",
                )}
              >
                {/* Text */}
                <div className="flex flex-col gap-4">
                  <span className="text-sm font-semibold uppercase tracking-wider text-emerald-500">
                    {feature.subtitle}
                  </span>
                  <h2 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-gray-50">
                    {feature.title}
                  </h2>
                  <p className="text-base text-gray-600 dark:text-gray-400">
                    {feature.description}
                  </p>
                </div>

                {/* Visual */}
                <div
                  className={cn(
                    "overflow-hidden rounded-2xl border",
                    "border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900",
                  )}
                >
                  {feature.visual}
                </div>
              </div>
            </FadeDiv>
          ))}
        </FadeContainer>
      </div>
    </section>
  )
}
