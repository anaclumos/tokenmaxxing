"use client";

import {
  ActivityHeatmap,
  heatmapThemeNames,
  heatmapThemes,
  heatmapViewNames,
  heatmapViews,
  type HeatmapDatum,
  type HeatmapTheme,
  type HeatmapView,
} from "@tokenmaxxing/ui/components/heatmap";
import { cn } from "@tokenmaxxing/ui/lib/utils";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

type ActivityHeatmapPanelProps = {
  data: HeatmapDatum[];
  years: number[];
  selectedYear?: number;
  clients: string[];
  selectedClient?: string;
  selectedDate?: string;
  initialTheme: HeatmapTheme;
  initialView: HeatmapView;
};

function buildActivityHref({
  pathname,
  year,
  client,
  day,
  theme,
  view,
}: {
  pathname: string;
  year?: number;
  client?: string;
  day?: string;
  theme: HeatmapTheme;
  view: HeatmapView;
}) {
  const params = new URLSearchParams();

  if (year) params.set("year", String(year));
  if (client) params.set("client", client);
  if (day) params.set("day", day);
  if (theme !== "green") params.set("theme", theme);
  if (view !== "flat") params.set("view", view);

  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function ActivityHeatmapPanel({
  data,
  years,
  selectedYear,
  clients,
  selectedClient,
  selectedDate,
  initialTheme,
  initialView,
}: ActivityHeatmapPanelProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [theme, setTheme] = useState(initialTheme);
  const [view, setView] = useState(initialView);

  useEffect(() => {
    setTheme(initialTheme);
  }, [initialTheme]);

  useEffect(() => {
    setView(initialView);
  }, [initialView]);

  function replaceVisualState({
    nextTheme,
    nextView,
  }: {
    nextTheme: HeatmapTheme;
    nextView: HeatmapView;
  }) {
    setTheme(nextTheme);
    setView(nextView);

    startTransition(() => {
      router.replace(
        buildActivityHref({
          pathname,
          year: selectedYear,
          client: selectedClient,
          day: selectedDate,
          theme: nextTheme,
          view: nextView,
        }),
        { scroll: false }
      );
    });
  }

  return (
    <div className="space-y-4">
      {years.length > 1 && (
        <div className="flex flex-wrap items-center gap-1">
          <Link
            href={buildActivityHref({
              pathname,
              client: selectedClient,
              theme,
              view,
            })}
            className={cn(
              "rounded px-2 py-1 text-xs font-mono",
              !selectedYear
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            Recent
          </Link>
          {years.map((year) => (
            <Link
              key={year}
              href={buildActivityHref({
                pathname,
                year,
                client: selectedClient,
                theme,
                view,
              })}
              className={cn(
                "rounded px-2 py-1 text-xs font-mono",
                selectedYear === year
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {year}
            </Link>
          ))}
        </div>
      )}

      {clients.length > 1 && (
        <div className="flex flex-wrap items-center gap-1">
          <Link
            href={buildActivityHref({
              pathname,
              year: selectedYear,
              theme,
              view,
            })}
            className={cn(
              "rounded px-2 py-1 text-xs font-mono",
              !selectedClient
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            All
          </Link>
          {clients.map((client) => (
            <Link
              key={client}
              href={buildActivityHref({
                pathname,
                year: selectedYear,
                client,
                theme,
                view,
              })}
              className={cn(
                "rounded px-2 py-1 text-xs font-mono",
                selectedClient === client
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {client}
            </Link>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
          Palette
        </span>
        <div className="flex flex-wrap gap-1">
          {heatmapThemeNames.map((themeName) => (
            <button
              key={themeName}
              type="button"
              onClick={() =>
                replaceVisualState({
                  nextTheme: themeName,
                  nextView: view,
                })
              }
              className={cn(
                "rounded px-2 py-1 text-xs font-mono transition-colors",
                theme === themeName
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
              aria-pressed={theme === themeName}
            >
              {heatmapThemes[themeName].label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
          View
        </span>
        <div className="flex flex-wrap gap-1">
          {heatmapViewNames.map((viewName) => (
            <button
              key={viewName}
              type="button"
              onClick={() =>
                replaceVisualState({
                  nextTheme: theme,
                  nextView: viewName,
                })
              }
              className={cn(
                "rounded px-2 py-1 text-xs font-mono transition-colors",
                view === viewName
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
              aria-pressed={view === viewName}
            >
              {heatmapViews[viewName].label}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto" aria-busy={isPending}>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={`${theme}:${view}`}
            initial={{ opacity: 0, y: 6, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.985 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="min-w-max"
          >
            <ActivityHeatmap
              data={data}
              year={selectedYear}
              selectedDate={selectedDate}
              theme={theme}
              view={view}
              hrefBuilder={(date) =>
                buildActivityHref({
                  pathname,
                  year: selectedYear,
                  client: selectedClient,
                  day: date,
                  theme,
                  view,
                })
              }
            />
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
