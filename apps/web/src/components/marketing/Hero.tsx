"use client"

import { cn } from "@tokenmaxxing/ui/lib/utils"
import Link from "next/link"

import { FadeContainer, FadeDiv, FadeSpan } from "@/components/marketing/Fade"
import GameOfLife from "@/components/marketing/HeroBackground"

export default function Hero() {
  return (
    <section className="relative flex min-h-96 flex-col items-center justify-center overflow-hidden px-4 pt-32 pb-24 text-center">
      {/* Background */}
      <div className="pointer-events-none absolute inset-0 -z-10 flex items-center justify-center">
        <GameOfLife />
      </div>

      <FadeContainer className="flex flex-col items-center gap-6">
        {/* News badge */}
        <FadeDiv>
          <span
            className={cn(
              "inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm",
              "bg-white/5 ring-1 ring-black/10 dark:bg-white/10 dark:ring-white/10",
              "text-gray-700 dark:text-gray-300",
            )}
          >
            <span className="rounded-full bg-emerald-500 px-2 py-0.5 text-xs font-semibold text-white">
              New
            </span>
            Now supporting Claude, Codex, Gemini, and more
          </span>
        </FadeDiv>

        {/* Headline */}
        <h1 className="flex flex-wrap justify-center gap-x-3 gap-y-1 text-5xl font-bold tracking-tight text-gray-900 sm:text-6xl dark:text-gray-50">
          <FadeSpan>Track every</FadeSpan>
          <FadeSpan>token spent</FadeSpan>
        </h1>

        {/* Subheading */}
        <FadeDiv>
          <p className="max-w-xl text-lg text-gray-700 dark:text-gray-400">
            Competitive token usage tracking across 14+ AI coding agents. See
            where you rank.
          </p>
        </FadeDiv>

        {/* CTA */}
        <FadeDiv>
          <Link
            href="/leaderboard"
            className={cn(
              "inline-flex items-center rounded-md px-5 py-3 text-sm font-semibold text-white",
              "bg-linear-to-b from-emerald-400 to-emerald-500",
              "border-b-2 border-emerald-700",
              "shadow-sm hover:shadow-md transition-shadow",
            )}
          >
            View Leaderboard
          </Link>
        </FadeDiv>
      </FadeContainer>
    </section>
  )
}
