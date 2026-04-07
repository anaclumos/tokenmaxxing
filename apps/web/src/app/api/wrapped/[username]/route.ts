import {
  dailyAggregates,
  rankings,
  usageRecords,
  users,
} from "@tokenmaxxing/db/index";
import { formatTokens, sumAggregateTokens } from "@tokenmaxxing/shared/types";
import { and, count, desc, eq, gte, lt } from "drizzle-orm";

import { db } from "@/lib/db";
import { TOKEN_SUM } from "@/lib/usage-queries";

const WIDTH = 1200;
const HEIGHT = 630;

function parseWrappedYear({ req }: { req: Request }) {
  const requestedYear = Number(new URL(req.url).searchParams.get("year"));
  return Number.isInteger(requestedYear)
    ? requestedYear
    : new Date().getFullYear();
}

function getYearRange({ year }: { year: number }) {
  return {
    startDate: `${year}-01-01`,
    endDate: `${year + 1}-01-01`,
    startTime: new Date(Date.UTC(year, 0, 1)),
    endTime: new Date(Date.UTC(year + 1, 0, 1)),
  };
}

function computeLongestStreak({ dates }: { dates: string[] }) {
  if (dates.length === 0) return 0;

  const sorted = [...new Set(dates)].toSorted();
  let longest = 1;
  let current = 1;

  for (let i = 1; i < sorted.length; i++) {
    const previous = new Date(sorted[i - 1]);
    const next = new Date(sorted[i]);
    const diff = (next.getTime() - previous.getTime()) / 86_400_000;

    if (diff === 1) {
      current += 1;
      longest = Math.max(longest, current);
      continue;
    }

    current = 1;
  }

  return longest;
}

function renderWrappedHeatmap({
  activityMap,
  year,
}: {
  activityMap: Map<string, number>;
  year: number;
}) {
  const cellSize = 10;
  const gap = 3;
  const max = Math.max(1, ...activityMap.values());
  const colors = ["#171c2a", "#1f4a7b", "#2b7fff", "#59a7ff", "#b2d8ff"];
  const start = new Date(Date.UTC(year, 0, 1));
  const now = new Date();
  const end =
    year === now.getUTCFullYear()
      ? new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
        )
      : new Date(Date.UTC(year, 11, 31));
  const cells: string[] = [];
  let week = 0;

  for (let date = new Date(start); ; date.setUTCDate(date.getUTCDate() + 1)) {
    if (date > end) break;

    const day = date.getUTCDay();
    if (day === 0 && date > start) week += 1;

    const key = date.toISOString().slice(0, 10);
    const value = activityMap.get(key) ?? 0;
    const level = value === 0 ? 0 : Math.min(4, Math.ceil((value / max) * 4));

    cells.push(
      `<rect x="${week * (cellSize + gap)}" y="${day * (cellSize + gap)}" width="${cellSize}" height="${cellSize}" rx="3" fill="${colors[level]}"/>`
    );
  }

  return cells.join("");
}

function getWrappedLists({
  topClients,
  topModels,
}: {
  topClients: string[];
  topModels: string[];
}) {
  return {
    clients: topClients.length > 0 ? topClients : ["none yet"],
    models: topModels.length > 0 ? topModels : ["none yet"],
  };
}

function renderList({
  items,
  x,
  y,
  fill,
}: {
  items: string[];
  x: number;
  y: number;
  fill: string;
}) {
  return items
    .map(
      (item, index) =>
        `<text x="${x}" y="${y + index * 30}" fill="${fill}" font-family="monospace" font-size="20">${esc(item)}</text>`
    )
    .join("");
}

function renderWrapped({
  username,
  year,
  totalTokens,
  totalCost,
  activeDays,
  sessions,
  longestStreak,
  rank,
  topClients,
  topModels,
  activityMap,
}: {
  username: string;
  year: number;
  totalTokens: number;
  totalCost: number;
  activeDays: number;
  sessions: number;
  longestStreak: number;
  rank: number | null;
  topClients: string[];
  topModels: string[];
  activityMap: Map<string, number>;
}) {
  const lists = getWrappedLists({ topClients, topModels });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" fill="none">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1200" y2="630" gradientUnits="userSpaceOnUse">
      <stop stop-color="#07111f"/>
      <stop offset="1" stop-color="#10192d"/>
    </linearGradient>
    <linearGradient id="accent" x1="120" y1="100" x2="520" y2="300" gradientUnits="userSpaceOnUse">
      <stop stop-color="#74b9ff"/>
      <stop offset="1" stop-color="#2b7fff"/>
    </linearGradient>
  </defs>

  <rect width="${WIDTH}" height="${HEIGHT}" rx="36" fill="url(#bg)"/>
  <circle cx="1040" cy="120" r="180" fill="#122445"/>
  <circle cx="1080" cy="80" r="120" fill="#17305f"/>

  <text x="80" y="92" fill="#8fb8ff" font-family="monospace" font-size="28">tokenmaxx.ing</text>
  <text x="80" y="150" fill="#f7fbff" font-family="system-ui, sans-serif" font-size="72" font-weight="700">${esc(username)}'s Wrapped</text>
  <text x="80" y="204" fill="url(#accent)" font-family="system-ui, sans-serif" font-size="42" font-weight="700">${year}</text>

  <text x="80" y="290" fill="#f7fbff" font-family="monospace" font-size="70" font-weight="700">${formatTokens(totalTokens)}</text>
  <text x="80" y="326" fill="#8ea3c7" font-family="monospace" font-size="24">tokens this year</text>

  <text x="80" y="392" fill="#e6edf7" font-family="monospace" font-size="26">$${totalCost.toFixed(2)} spent</text>
  <text x="80" y="430" fill="#e6edf7" font-family="monospace" font-size="26">${sessions.toLocaleString()} sessions</text>
  <text x="80" y="468" fill="#e6edf7" font-family="monospace" font-size="26">${activeDays.toLocaleString()} active days</text>
  <text x="80" y="506" fill="#e6edf7" font-family="monospace" font-size="26">${longestStreak}d longest streak</text>
  ${rank ? `<text x="80" y="544" fill="#e6edf7" font-family="monospace" font-size="26">all-time rank #${rank}</text>` : ""}

  <text x="650" y="114" fill="#8ea3c7" font-family="monospace" font-size="22">top clients</text>
  ${renderList({ items: lists.clients, x: 650, y: 152, fill: "#f7fbff" })}

  <text x="650" y="274" fill="#8ea3c7" font-family="monospace" font-size="22">top models</text>
  ${renderList({ items: lists.models, x: 650, y: 312, fill: "#f7fbff" })}

  <g transform="translate(650, 390)">
    ${renderWrappedHeatmap({ activityMap, year })}
  </g>
  <text x="650" y="548" fill="#8ea3c7" font-family="monospace" font-size="18">calendar activity for ${year}</text>
</svg>`;
}

function notFoundSvg({ username }: { username: string }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" rx="36" fill="#07111f"/>
  <text x="80" y="150" fill="#f7fbff" font-family="system-ui, sans-serif" font-size="64" font-weight="700">${esc(username)}</text>
  <text x="80" y="230" fill="#8ea3c7" font-family="monospace" font-size="28">wrapped image unavailable</text>
</svg>`;
}

function esc(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ username: string }> }
) {
  const { username } = await params;
  const year = parseWrappedYear({ req });
  const { startDate, endDate, startTime, endTime } = getYearRange({ year });

  const [user] = await db()
    .select({
      id: users.id,
      username: users.username,
      privacyMode: users.privacyMode,
    })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);

  if (!user || user.privacyMode) {
    return new Response(notFoundSvg({ username }), {
      status: 404,
      headers: {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=300",
      },
    });
  }

  const [[globalRank], activityRows, topClientRows, topModelRows] =
    await Promise.all([
      db()
        .select({ rank: rankings.rank })
        .from(rankings)
        .where(
          and(
            eq(rankings.leaderboardId, "global"),
            eq(rankings.userId, user.id),
            eq(rankings.period, "alltime")
          )
        )
        .limit(1),
      db()
        .select({
          date: dailyAggregates.date,
          totalInput: dailyAggregates.totalInput,
          totalOutput: dailyAggregates.totalOutput,
          totalCacheRead: dailyAggregates.totalCacheRead,
          totalCacheWrite: dailyAggregates.totalCacheWrite,
          totalReasoning: dailyAggregates.totalReasoning,
          totalCost: dailyAggregates.totalCost,
          sessionCount: dailyAggregates.sessionCount,
        })
        .from(dailyAggregates)
        .where(
          and(
            eq(dailyAggregates.userId, user.id),
            gte(dailyAggregates.date, startDate),
            lt(dailyAggregates.date, endDate)
          )
        )
        .orderBy(desc(dailyAggregates.date)),
      db()
        .select({
          label: usageRecords.client,
          sessions: count(),
        })
        .from(usageRecords)
        .where(
          and(
            eq(usageRecords.userId, user.id),
            gte(usageRecords.timestamp, startTime),
            lt(usageRecords.timestamp, endTime)
          )
        )
        .groupBy(usageRecords.client)
        .orderBy(desc(count()), desc(TOKEN_SUM))
        .limit(3),
      db()
        .select({
          label: usageRecords.model,
          sessions: count(),
        })
        .from(usageRecords)
        .where(
          and(
            eq(usageRecords.userId, user.id),
            gte(usageRecords.timestamp, startTime),
            lt(usageRecords.timestamp, endTime)
          )
        )
        .groupBy(usageRecords.model)
        .orderBy(desc(count()), desc(TOKEN_SUM))
        .limit(3),
    ]);

  const activityMap = new Map<string, number>();
  let totalTokens = 0;
  let totalCost = 0;
  let sessions = 0;

  for (const activity of activityRows) {
    const dayTokens = sumAggregateTokens(activity);
    activityMap.set(activity.date, dayTokens);
    totalTokens += dayTokens;
    totalCost += Number(activity.totalCost);
    sessions += activity.sessionCount;
  }

  const svg = renderWrapped({
    username: user.username,
    year,
    totalTokens,
    totalCost,
    activeDays: activityRows.length,
    sessions,
    longestStreak: computeLongestStreak({
      dates: activityRows.map((activity) => activity.date),
    }),
    rank: globalRank?.rank ?? null,
    topClients: topClientRows.map((row) => row.label),
    topModels: topModelRows.map((row) => row.label),
    activityMap,
  });

  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=1800, s-maxage=1800",
    },
  });
}
