import { cn } from "@tokenmaxxing/ui/lib/utils"

const stats = [
  { value: "10B+", label: "tokens tracked" },
  { value: "1,000+", label: "users" },
  { value: "$500K+", label: "total spend tracked" },
]

export default function Testimonial() {
  return (
    <section
      className={cn(
        "py-24",
        "bg-gradient-to-br from-gray-50 via-orange-50 to-amber-50",
        "dark:from-gray-900 dark:via-gray-900 dark:to-gray-800",
      )}
    >
      <div className="mx-auto max-w-4xl px-4 text-center">
        <blockquote className="text-3xl font-semibold leading-snug tracking-tight text-gray-900 sm:text-4xl dark:text-gray-50">
          "Tracking the AI coding revolution, one token at a time."
        </blockquote>

        <div className="mt-16 grid grid-cols-1 gap-8 sm:grid-cols-3">
          {stats.map(({ value, label }) => (
            <div key={label} className="flex flex-col items-center gap-1">
              <span className="text-4xl font-bold text-orange-500">{value}</span>
              <span className="text-sm text-gray-600 dark:text-gray-400">
                {label}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
