"use client"

import { Show, SignInButton, UserButton } from "@clerk/nextjs"
import { buttonVariants } from "@tokenmaxxing/ui/components/button"
import { cn } from "@tokenmaxxing/ui/lib/utils"
import { RiCloseFill, RiMenuFill } from "@remixicon/react"
import Link from "next/link"
import { useState } from "react"

import { ThemeToggle } from "@/components/app/ThemeToggle"
import useScroll from "@/lib/useScroll"

const navLinks = [
  { label: "Leaderboard", href: "/leaderboard" },
  { label: "Docs", href: "/app/docs" },
]

export default function MarketingNavbar() {
  const scrolled = useScroll(15)
  const [mobileOpen, setMobileOpen] = useState(false)

  return (
    <header
      className={cn(
        "fixed top-0 right-0 left-0 z-50 transition-all duration-300",
        scrolled
          ? "border-b border-gray-200/50 bg-white/80 backdrop-blur-md dark:border-gray-800/50 dark:bg-gray-950/80"
          : "border-b border-transparent bg-transparent",
      )}
    >
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        {/* Logo */}
        <Link
          href="/"
          className="text-base font-semibold tracking-tight text-gray-900 dark:text-gray-50"
        >
          tokenmaxx.ing
        </Link>

        {/* Desktop nav */}
        <nav className="hidden items-center gap-1 md:flex">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={cn(
                buttonVariants({ variant: "ghost", size: "sm" }),
                "text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-50",
              )}
            >
              {link.label}
            </Link>
          ))}
        </nav>

        {/* Desktop right side */}
        <div className="hidden items-center gap-2 md:flex">
          <ThemeToggle />
          <Show when="signed-out">
            <SignInButton mode="modal">
              <button
                className={cn(
                  "inline-flex items-center rounded-md px-4 py-2 text-sm font-semibold text-white",
                  "bg-linear-to-b from-emerald-400 to-emerald-500",
                  "border-b-2 border-emerald-700",
                  "shadow-sm hover:shadow-md transition-shadow cursor-pointer",
                )}
              >
                Sign in
              </button>
            </SignInButton>
          </Show>
          <Show when="signed-in">
            <Link
              href="/app"
              className={cn(
                buttonVariants({ variant: "ghost", size: "sm" }),
                "text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-50",
              )}
            >
              Dashboard
            </Link>
            <UserButton />
          </Show>
        </div>

        {/* Mobile right side */}
        <div className="flex items-center gap-1 md:hidden">
          <ThemeToggle />
          <button
            type="button"
            className="flex items-center justify-center rounded-lg p-2 text-gray-600 hover:bg-gray-200 dark:text-gray-400 dark:hover:bg-gray-800"
          onClick={() => setMobileOpen((prev) => !prev)}
          aria-label={mobileOpen ? "Close menu" : "Open menu"}
        >
            {mobileOpen ? <RiCloseFill className="size-5" /> : <RiMenuFill className="size-5" />}
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      {mobileOpen && (
        <div className="border-t border-gray-200/50 bg-white/90 px-4 py-3 backdrop-blur-md dark:border-gray-800/50 dark:bg-gray-950/90 md:hidden">
          <nav className="flex flex-col gap-1">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={cn(
                  buttonVariants({ variant: "ghost", size: "sm" }),
                  "justify-start text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-50",
                )}
                onClick={() => setMobileOpen(false)}
              >
                {link.label}
              </Link>
            ))}
            <div className="mt-2 flex flex-col gap-1 border-t border-gray-200/50 pt-2 dark:border-gray-800/50">
              <Show when="signed-out">
                <SignInButton mode="modal">
                  <button
                    className={cn(
                      "inline-flex w-full items-center justify-center rounded-md px-4 py-2 text-sm font-semibold text-white",
                      "bg-linear-to-b from-emerald-400 to-emerald-500",
                      "border-b-2 border-emerald-700",
                      "shadow-sm hover:shadow-md transition-shadow cursor-pointer",
                    )}
                  >
                    Sign in
                  </button>
                </SignInButton>
              </Show>
              <Show when="signed-in">
                <Link
                  href="/app"
                  className={cn(
                    buttonVariants({ variant: "ghost", size: "sm" }),
                    "justify-start text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-50",
                  )}
                  onClick={() => setMobileOpen(false)}
                >
                  Dashboard
                </Link>
                <div className="px-2 py-1">
                  <UserButton />
                </div>
              </Show>
            </div>
          </nav>
        </div>
      )}
    </header>
  )
}
