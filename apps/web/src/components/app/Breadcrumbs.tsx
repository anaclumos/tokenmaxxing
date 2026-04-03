"use client"

import { usePathname } from "next/navigation"
import { ChevronRight } from "lucide-react"
import Link from "next/link"

const labels: Record<string, string> = {
  app: "Dashboard",
  settings: "Settings",
  docs: "Docs",
  orgs: "Organizations",
  create: "Create",
  leaderboard: "Leaderboard",
  analytics: "Analytics",
}

export function Breadcrumbs() {
  const pathname = usePathname()
  const segments = pathname.split("/").filter(Boolean)

  // Build breadcrumb items from path segments
  const items = segments.map((segment, index) => {
    const href = "/" + segments.slice(0, index + 1).join("/")
    const label = labels[segment] || segment
    const isLast = index === segments.length - 1
    return { href, label, isLast }
  })

  return (
    <nav aria-label="Breadcrumb" className="ml-2">
      <ol role="list" className="flex items-center space-x-3 text-sm">
        {items.map((item, i) => (
          <li key={item.href} className="flex items-center gap-3">
            {i > 0 && (
              <ChevronRight
                className="size-4 shrink-0 text-gray-600 dark:text-gray-400"
                aria-hidden="true"
              />
            )}
            {item.isLast ? (
              <span className="text-gray-900 dark:text-gray-50">
                {item.label}
              </span>
            ) : (
              <Link
                href={item.href}
                className="text-gray-500 transition hover:text-gray-700 dark:text-gray-400 hover:dark:text-gray-300"
              >
                {item.label}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  )
}
