import { users, dailyAggregates, rankings } from "@tokenmaxxing/db/index";
import {
  getEarnedBadges,
  renderProfileBadgeIconSvg,
  type ProfileBadgeIcon,
} from "@tokenmaxxing/shared/badges";
import { summarizeDailyAggregateRows } from "@tokenmaxxing/shared/daily-aggregate-summary";
import { formatTokens } from "@tokenmaxxing/shared/types";
import { eq, desc, and } from "drizzle-orm";

import { canAccessPrivateUser } from "@/lib/auth";
import { db } from "@/lib/db";

export async function GET(req: Request, { params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;

  const [user] = await db().select().from(users).where(eq(users.username, username)).limit(1);

  const isOwner = user ? await canAccessPrivateUser({ req, user }) : false;
  if (!user || (user.privacyMode && !isOwner)) {
    return new Response(notFoundSvg(username), {
      status: 404,
      headers: {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=300",
      },
    });
  }

  // Last 365 days of activity for heatmap + rank
  const [[globalRank], activityRows] = await Promise.all([
    db()
      .select({ rank: rankings.rank, compositeScore: rankings.compositeScore })
      .from(rankings)
      .where(
        and(
          eq(rankings.leaderboardId, "global"),
          eq(rankings.userId, user.id),
          eq(rankings.period, "alltime"),
        ),
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
        modelsUsed: dailyAggregates.modelsUsed,
        clientsUsed: dailyAggregates.clientsUsed,
      })
      .from(dailyAggregates)
      .where(eq(dailyAggregates.userId, user.id))
      .orderBy(desc(dailyAggregates.date))
      .limit(365),
  ]);

  const summary = summarizeDailyAggregateRows({ rows: activityRows });

  const svg = renderCard({
    username: user.username,
    rank: globalRank?.rank ?? null,
    score: globalRank ? Number(globalRank.compositeScore) : null,
    totalTokens: user.totalTokens,
    totalCost: Number(user.totalCost),
    streak: user.currentStreak,
    activityMap: summary.activityMap,
    badges: getEarnedBadges({
      context: {
        totalTokens: user.totalTokens,
        longestStreak: user.longestStreak,
        clientCount: summary.clients.length,
        modelCount: summary.models.length,
        cacheHitRate: summary.cacheHitRate,
        activeDays: summary.activeDays,
      },
    }),
  });

  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control":
        user.privacyMode && isOwner ? "private, no-store" : "public, max-age=1800, s-maxage=1800",
      Vary: "Authorization",
    },
  });
}

// --- SVG rendering ---

const W = 480;
const H = 195;
const BG = "#0d1117";
const FG = "#e6edf3";
const MUTED = "#7d8590";
const ACCENT = "#58a6ff";
const GREENS = ["#161b22", "#0e4429", "#006d32", "#26a641", "#39d353"];

function renderCard(data: {
  username: string;
  rank: number | null;
  score: number | null;
  totalTokens: number;
  totalCost: number;
  streak: number;
  activityMap: Map<string, number>;
  badges: Array<{ icon: ProfileBadgeIcon; mark: string; tone: string }>;
}): string {
  const heatmap = renderHeatmap(data.activityMap);
  const badgeStrip = renderBadgeStrip(data.badges);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" fill="none">
  <rect width="${W}" height="${H}" rx="6" fill="${BG}" stroke="#30363d" stroke-width="1"/>

  <!-- Title -->
  <text x="20" y="30" fill="${MUTED}" font-family="monospace" font-size="11">tokenmaxx.ing</text>

  <!-- Username + Rank -->
  <text x="20" y="54" fill="${FG}" font-family="monospace" font-size="16" font-weight="bold">${esc(data.username)}</text>
  ${data.rank ? `<text x="${W - 20}" y="54" fill="${ACCENT}" font-family="monospace" font-size="14" text-anchor="end">Rank #${data.rank}</text>` : ""}

  <!-- Stats row -->
  <text x="20" y="80" fill="${FG}" font-family="monospace" font-size="12">${formatTokens(data.totalTokens)} tokens</text>
  <text x="160" y="80" fill="${FG}" font-family="monospace" font-size="12">$${data.totalCost.toFixed(2)}</text>
  <text x="280" y="80" fill="${FG}" font-family="monospace" font-size="12">${data.streak}d streak</text>
  ${data.score ? `<text x="380" y="80" fill="${MUTED}" font-family="monospace" font-size="12">score ${Math.round(data.score)}</text>` : ""}
  ${badgeStrip}

  <!-- Heatmap -->
  <g transform="translate(20, 125)">
    ${heatmap}
  </g>
</svg>`;
}

function renderBadgeStrip(badges: Array<{ icon: ProfileBadgeIcon; mark: string; tone: string }>) {
  const toneColors = {
    sky: { fill: "#132645", stroke: "#4a9eff", text: "#d7e9ff" },
    violet: { fill: "#23163f", stroke: "#9b6dff", text: "#eadfff" },
    emerald: { fill: "#102d28", stroke: "#2fc68d", text: "#d8fff2" },
    amber: { fill: "#34230e", stroke: "#f4b14b", text: "#fff0d6" },
    rose: { fill: "#3a1624", stroke: "#f06292", text: "#ffe0ea" },
  } as const;

  return badges
    .slice(0, 3)
    .map((badge, index) => {
      const x = 20 + index * 82;
      const tone = toneColors[badge.tone as keyof typeof toneColors] ?? toneColors.sky;
      return `<g transform="translate(${x}, 92)">
  <rect width="70" height="20" rx="10" fill="${tone.fill}" stroke="${tone.stroke}" stroke-width="1"/>
  ${renderProfileBadgeIconSvg({ icon: badge.icon, size: 10, stroke: tone.text, x: 7, y: 5 })}
  <text x="43" y="14" fill="${tone.text}" font-family="monospace" font-size="10" text-anchor="middle">${esc(badge.mark)}</text>
</g>`;
    })
    .join("\n  ");
}

function renderHeatmap(activityMap: Map<string, number>): string {
  // Find max for color scaling
  const values = [...activityMap.values()];
  const max = values.length > 0 ? Math.max(...values) : 1;

  // Build 52 weeks x 7 days grid, ending today
  const today = new Date();
  const cells: string[] = [];
  const cellSize = 7;
  const gap = 1;

  for (let week = 0; week < 52; week++) {
    for (let day = 0; day < 7; day++) {
      const daysAgo = (51 - week) * 7 + (6 - day);
      const date = new Date(today);
      date.setDate(date.getDate() - daysAgo);
      const dateStr = date.toISOString().slice(0, 10);
      const value = activityMap.get(dateStr) ?? 0;

      const level = value === 0 ? 0 : Math.min(4, Math.ceil((value / max) * 4));
      const color = GREENS[level];

      const x = week * (cellSize + gap);
      const y = day * (cellSize + gap);
      cells.push(
        `<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" rx="1.5" fill="${color}"/>`,
      );
    }
  }

  return cells.join("\n    ");
}

function notFoundSvg(username: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="60" viewBox="0 0 ${W} 60" fill="none">
  <rect width="${W}" height="60" rx="6" fill="${BG}" stroke="#30363d" stroke-width="1"/>
  <text x="${W / 2}" y="35" fill="${MUTED}" font-family="monospace" font-size="13" text-anchor="middle">${esc(username)} not found</text>
</svg>`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
