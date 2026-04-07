import { RiGithubFill } from "@remixicon/react";
import { cn } from "@tokenmaxxing/ui/lib/utils";
import Link from "next/link";

const footerSections = [
  {
    title: "Product",
    links: [
      { label: "Leaderboard", href: "/leaderboard" },
      { label: "Dashboard", href: "/app" },
      { label: "CLI", href: "https://www.npmjs.com/package/tokenmaxxing" },
      { label: "API", href: "/docs" },
    ],
  },
  {
    title: "Developers",
    links: [
      { label: "Documentation", href: "/docs" },
      { label: "GitHub", href: "https://github.com/anaclumos/tokenmaxxing" },
    ],
  },
];

const socialLinks = [
  {
    label: "GitHub",
    href: "https://github.com/anaclumos/tokenmaxxing",
    icon: RiGithubFill,
  },
];

export default function MarketingFooter() {
  const year = new Date().getFullYear();

  return (
    <footer className="relative border-t border-gray-300 dark:border-gray-700">
      {/* Decorative SVG pattern divider */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 -translate-y-px overflow-hidden"
      >
        <svg
          className="w-full"
          height="8"
          viewBox="0 0 1440 8"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          preserveAspectRatio="none"
        >
          <path
            d="M0 0L1440 0L1440 8L0 8L0 0Z"
            className="fill-gray-100 dark:fill-gray-900"
          />
        </svg>
      </div>

      <div className="mx-auto max-w-6xl px-4 py-12">
        <div className="relative grid grid-cols-2 gap-8 md:grid-cols-4">
          {/* Dashed vertical lines decoration */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-1/2 hidden w-px -translate-x-1/2 border-l border-dashed border-gray-300 dark:border-gray-700 md:block"
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-1/4 hidden w-px -translate-x-1/2 border-l border-dashed border-gray-300 dark:border-gray-700 md:block"
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-3/4 hidden w-px -translate-x-1/2 border-l border-dashed border-gray-300 dark:border-gray-700 md:block"
          />

          {/* Brand column */}
          <div className="col-span-2 flex flex-col gap-4 md:col-span-1">
            <Link
              href="/"
              className="text-base font-semibold tracking-tight text-gray-900 dark:text-gray-50"
            >
              tokenmaxx.ing
            </Link>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              Compete on token consumption across all AI coding agents.
            </p>
            <div className="flex items-center gap-2">
              {socialLinks.map((social) => (
                <a
                  key={social.label}
                  href={social.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={social.label}
                  className={cn(
                    "flex size-8 items-center justify-center rounded-lg",
                    "text-gray-600 hover:bg-gray-200 hover:text-gray-900",
                    "dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-50",
                    "transition-colors"
                  )}
                >
                  <social.icon className="size-4" />
                </a>
              ))}
            </div>
          </div>

          {/* Spacer for md grid alignment */}
          <div className="hidden md:block" />

          {/* Link sections */}
          {footerSections.map((section) => (
            <div key={section.title} className="flex flex-col gap-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-gray-900 dark:text-gray-50">
                {section.title}
              </p>
              <ul className="flex flex-col gap-2">
                {section.links.map((link) => (
                  <li key={link.label}>
                    {link.href.startsWith("http") ? (
                      <a
                        href={link.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-gray-600 transition-colors hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-50"
                      >
                        {link.label}
                      </a>
                    ) : (
                      <Link
                        href={link.href}
                        className="text-sm text-gray-600 transition-colors hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-50"
                      >
                        {link.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Bottom bar */}
        <div className="mt-12 flex flex-col items-center justify-between gap-4 border-t border-gray-300 pt-6 dark:border-gray-700 sm:flex-row">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            &copy; {year} tokenmaxx.ing. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}
