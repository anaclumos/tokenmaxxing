import { users, dailyAggregates } from "@tokenmaxxing/db/index";
import { buttonVariants } from "@tokenmaxxing/ui/components/button";
import { cn } from "@tokenmaxxing/ui/lib/utils";
import { eq, desc } from "drizzle-orm";
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";

import { db } from "@/lib/db";

import { ShareButton } from "../share-button";

const SITE_URL = "https://tokenmaxx.ing";

function parseWrappedYear({ year }: { year?: string }) {
  const requestedYear = Number(year);
  return Number.isInteger(requestedYear) ? requestedYear : new Date().getFullYear();
}

function getWrappedImageUrl({
  username,
  year,
}: {
  username: string;
  year: number;
}) {
  return `/api/wrapped/${username}?year=${year}`;
}

function getWrappedImageHref({
  username,
  year,
}: {
  username: string;
  year: number;
}) {
  return `${SITE_URL}${getWrappedImageUrl({ username, year })}`;
}

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ username: string }>;
  searchParams: Promise<{ year?: string }>;
}): Promise<Metadata> {
  const [{ username }, query] = await Promise.all([params, searchParams]);
  const year = parseWrappedYear({ year: query.year });
  const image = getWrappedImageHref({ username, year });

  return {
    title: `${username}'s Wrapped ${year} - tokenmaxx.ing`,
    description: `${username}'s year in review on tokenmaxx.ing`,
    openGraph: {
      title: `${username}'s Wrapped ${year}`,
      description: `${username}'s year in review on tokenmaxx.ing`,
      images: [image],
    },
    twitter: {
      card: "summary_large_image",
      title: `${username}'s Wrapped ${year}`,
      description: `${username}'s year in review on tokenmaxx.ing`,
      images: [image],
    },
  };
}

export default async function WrappedPage({
  params,
  searchParams,
}: {
  params: Promise<{ username: string }>;
  searchParams: Promise<{ year?: string }>;
}) {
  const [{ username }, query] = await Promise.all([params, searchParams]);

  const [user, activityRows] = await Promise.all([
    db()
      .select({
        username: users.username,
        privacyMode: users.privacyMode,
      })
      .from(users)
      .where(eq(users.username, username))
      .limit(1)
      .then((rows) => rows[0]),
    db()
      .select({ date: dailyAggregates.date })
      .from(dailyAggregates)
      .innerJoin(users, eq(dailyAggregates.userId, users.id))
      .where(eq(users.username, username))
      .orderBy(desc(dailyAggregates.date)),
  ]);

  if (!user || user.privacyMode) notFound();

  const availableYears = [
    ...new Set(activityRows.map((row) => Number(row.date.slice(0, 4)))),
  ].toSorted((a, b) => b - a);
  const currentYear = new Date().getFullYear();
  const selectedYear =
    availableYears.find((year) => year === parseWrappedYear({ year: query.year })) ??
    availableYears[0] ??
    currentYear;
  const years = availableYears.length > 0 ? availableYears : [currentYear];
  const wrappedImageUrl = getWrappedImageUrl({
    username: user.username,
    year: selectedYear,
  });

  return (
    <main className="flex flex-1 flex-col bg-linear-to-br from-sky-100 via-white to-blue-50 px-6 pb-12 pt-20 dark:from-slate-950 dark:via-slate-950 dark:to-blue-950">
      <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-3">
            <Link
              href={`/u/${user.username}`}
              className="font-mono text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              /u/{user.username}
            </Link>
            <div className="space-y-2">
              <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
                {user.username}'s Wrapped
              </h1>
              <p className="max-w-2xl text-base text-muted-foreground sm:text-lg">
                A shareable year-in-review card built from tokenmaxx.ing usage history.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {years.map((year) => (
              <Link
                key={year}
                href={`/u/${user.username}/wrapped?year=${year}`}
                className={cn(
                  buttonVariants({ variant: "outline", size: "sm" }),
                  selectedYear === year && "bg-background text-foreground",
                )}
              >
                {year}
              </Link>
            ))}
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
          <div className="overflow-hidden rounded-3xl border border-border bg-white shadow-sm dark:bg-slate-950">
            <Image
              src={wrappedImageUrl}
              alt={`${user.username}'s wrapped card for ${selectedYear}`}
              width={1200}
              height={630}
              unoptimized
              className="h-auto w-full"
            />
          </div>

          <aside className="flex flex-col gap-4 rounded-3xl border border-border bg-white p-6 shadow-sm dark:bg-slate-950">
            <div className="space-y-2">
              <p className="font-mono text-sm text-muted-foreground">wrapped/{selectedYear}</p>
              <p className="text-sm text-muted-foreground">
                Open the raw SVG, use it in social previews, or jump back to the profile.
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <ShareButton
                path={`/u/${user.username}/wrapped?year=${selectedYear}`}
                text={`${user.username}'s Wrapped ${selectedYear} on tokenmaxx.ing`}
              />
              <Link
                href={wrappedImageUrl}
                prefetch={false}
                className={cn(buttonVariants({ variant: "default", size: "sm" }))}
              >
                Open SVG
              </Link>
              <a
                href={wrappedImageUrl}
                download={`${user.username}-wrapped-${selectedYear}.svg`}
                className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
              >
                Download SVG
              </a>
              <Link
                href={`/u/${user.username}`}
                className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
              >
                Back to Profile
              </Link>
            </div>
          </aside>
        </div>
      </div>
    </main>
  );
}
