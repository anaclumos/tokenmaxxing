export const profileBadgeTones = ["sky", "violet", "emerald", "amber", "rose"] as const;
export const profileBadgeIcons = [
  "upload",
  "calendar-days",
  "calendar",
  "flame",
  "rocket",
  "users",
  "bot",
  "zap",
  "medal",
  "crown",
] as const;

export type ProfileBadgeTone = (typeof profileBadgeTones)[number];
export type ProfileBadgeIcon = (typeof profileBadgeIcons)[number];

export type ProfileBadge = {
  id: string;
  mark: string;
  name: string;
  description: string;
  icon: ProfileBadgeIcon;
  tone: ProfileBadgeTone;
};

const profileBadgeIconNodes = {
  upload: [
    ["path", { d: "M12 3v12" }],
    ["path", { d: "m17 8-5-5-5 5" }],
    ["path", { d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" }],
  ],
  "calendar-days": [
    ["path", { d: "M8 2v4" }],
    ["path", { d: "M16 2v4" }],
    ["rect", { width: "18", height: "18", x: "3", y: "4", rx: "2" }],
    ["path", { d: "M3 10h18" }],
    ["path", { d: "M8 14h.01" }],
    ["path", { d: "M12 14h.01" }],
    ["path", { d: "M16 14h.01" }],
    ["path", { d: "M8 18h.01" }],
    ["path", { d: "M12 18h.01" }],
    ["path", { d: "M16 18h.01" }],
  ],
  calendar: [
    ["path", { d: "M8 2v4" }],
    ["path", { d: "M16 2v4" }],
    ["rect", { width: "18", height: "18", x: "3", y: "4", rx: "2" }],
    ["path", { d: "M3 10h18" }],
  ],
  flame: [
    [
      "path",
      {
        d: "M12 3q1 4 4 6.5t3 5.5a1 1 0 0 1-14 0 5 5 0 0 1 1-3 1 1 0 0 0 5 0c0-2-1.5-3-1.5-5q0-2 2.5-4",
      },
    ],
  ],
  rocket: [
    ["path", { d: "M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" }],
    [
      "path",
      {
        d: "M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09",
      },
    ],
    [
      "path",
      {
        d: "M9 12a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.4 22.4 0 0 1-4 2z",
      },
    ],
    ["path", { d: "M9 12H4s.55-3.03 2-4c1.62-1.08 5 .05 5 .05" }],
  ],
  users: [
    ["path", { d: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" }],
    ["path", { d: "M16 3.128a4 4 0 0 1 0 7.744" }],
    ["path", { d: "M22 21v-2a4 4 0 0 0-3-3.87" }],
    ["circle", { cx: "9", cy: "7", r: "4" }],
  ],
  bot: [
    ["path", { d: "M12 8V4H8" }],
    ["rect", { width: "16", height: "12", x: "4", y: "8", rx: "2" }],
    ["path", { d: "M2 14h2" }],
    ["path", { d: "M20 14h2" }],
    ["path", { d: "M15 13v2" }],
    ["path", { d: "M9 13v2" }],
  ],
  zap: [
    [
      "path",
      {
        d: "M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z",
      },
    ],
  ],
  medal: [
    [
      "path",
      {
        d: "M7.21 15 2.66 7.14a2 2 0 0 1 .13-2.2L4.4 2.8A2 2 0 0 1 6 2h12a2 2 0 0 1 1.6.8l1.6 2.14a2 2 0 0 1 .14 2.2L16.79 15",
      },
    ],
    ["path", { d: "M11 12 5.12 2.2" }],
    ["path", { d: "m13 12 5.88-9.8" }],
    ["path", { d: "M8 7h8" }],
    ["circle", { cx: "12", cy: "17", r: "5" }],
    ["path", { d: "M12 18v-2h-.5" }],
  ],
  crown: [
    [
      "path",
      {
        d: "M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z",
      },
    ],
    ["path", { d: "M5 21h14" }],
  ],
} as const satisfies Record<
  ProfileBadgeIcon,
  readonly (readonly [string, Record<string, string>])[]
>;

type FeaturedBadgeFormat = "name" | "mark";

type BadgeContext = {
  totalTokens: number;
  longestStreak: number;
  clientCount: number;
  modelCount: number;
  cacheHitRate: number;
  activeDays: number;
};

const badgeDefinitions = [
  {
    id: "first-submit",
    mark: "FS",
    name: "First Submit",
    description: "Uploaded your first usage record.",
    icon: "upload",
    tone: "sky",
    qualifies: ({ totalTokens }: BadgeContext) => totalTokens > 0,
  },
  {
    id: "power-week",
    mark: "7D",
    name: "Power Week",
    description: "Stayed active for at least 7 days.",
    icon: "calendar-days",
    tone: "emerald",
    qualifies: ({ activeDays }: BadgeContext) => activeDays >= 7,
  },
  {
    id: "marathon-month",
    mark: "30D",
    name: "Marathon Month",
    description: "Stayed active for at least 30 days.",
    icon: "calendar",
    tone: "amber",
    qualifies: ({ activeDays }: BadgeContext) => activeDays >= 30,
  },
  {
    id: "streak-7",
    mark: "S7",
    name: "Streak 7",
    description: "Reached a 7-day streak.",
    icon: "flame",
    tone: "sky",
    qualifies: ({ longestStreak }: BadgeContext) => longestStreak >= 7,
  },
  {
    id: "streak-30",
    mark: "S30",
    name: "Streak 30",
    description: "Reached a 30-day streak.",
    icon: "rocket",
    tone: "violet",
    qualifies: ({ longestStreak }: BadgeContext) => longestStreak >= 30,
  },
  {
    id: "multi-client",
    mark: "3+",
    name: "Multi-Client",
    description: "Used at least 3 coding clients.",
    icon: "users",
    tone: "emerald",
    qualifies: ({ clientCount }: BadgeContext) => clientCount >= 3,
  },
  {
    id: "model-explorer",
    mark: "10M",
    name: "Model Explorer",
    description: "Used at least 10 different models.",
    icon: "bot",
    tone: "violet",
    qualifies: ({ modelCount }: BadgeContext) => modelCount >= 10,
  },
  {
    id: "efficient",
    mark: "50%",
    name: "Efficient",
    description: "Maintained a 50%+ cache hit rate.",
    icon: "zap",
    tone: "emerald",
    qualifies: ({ cacheHitRate }: BadgeContext) => cacheHitRate >= 50,
  },
  {
    id: "billion-club",
    mark: "1B",
    name: "1B Club",
    description: "Surpassed 1 billion total tokens.",
    icon: "medal",
    tone: "amber",
    qualifies: ({ totalTokens }: BadgeContext) => totalTokens >= 1_000_000_000,
  },
  {
    id: "ten-billion-club",
    mark: "10B",
    name: "10B Club",
    description: "Surpassed 10 billion total tokens.",
    icon: "crown",
    tone: "rose",
    qualifies: ({ totalTokens }: BadgeContext) => totalTokens >= 10_000_000_000,
  },
] as const;

export function getEarnedBadges({ context }: { context: BadgeContext }) {
  return badgeDefinitions
    .filter((badge) => badge.qualifies(context))
    .map(({ id, mark, name, description, icon, tone }) => ({
      id,
      mark,
      name,
      description,
      icon,
      tone,
    }));
}

export function getFeaturedBadge({ context }: { context: BadgeContext }) {
  return getEarnedBadges({ context }).at(-1) ?? null;
}

export function getFeaturedBadgeValue({
  context,
  format,
}: {
  context: BadgeContext;
  format: FeaturedBadgeFormat;
}) {
  const badge = getFeaturedBadge({ context });
  if (!badge) return null;
  return format === "mark" ? badge.mark : badge.name;
}

export function renderProfileBadgeIconSvg({
  icon,
  size,
  stroke,
  x = 0,
  y = 0,
}: {
  icon: ProfileBadgeIcon;
  size: number;
  stroke: string;
  x?: number;
  y?: number;
}) {
  const nodes = profileBadgeIconNodes[icon]
    .map(([tag, attributes]) => {
      const attrs = Object.entries(attributes)
        .map(([key, value]) => `${key}="${value}"`)
        .join(" ");
      return `<${tag} ${attrs}/>`;
    })
    .join("");

  return `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${nodes}</svg>`;
}
