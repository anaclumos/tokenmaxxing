export type ProfileBadgeTone = "sky" | "violet" | "emerald" | "amber" | "rose";

export type ProfileBadge = {
  id: string;
  mark: string;
  name: string;
  description: string;
  tone: ProfileBadgeTone;
};

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
    tone: "sky",
    qualifies: ({ totalTokens }: BadgeContext) => totalTokens > 0,
  },
  {
    id: "power-week",
    mark: "7D",
    name: "Power Week",
    description: "Stayed active for at least 7 days.",
    tone: "emerald",
    qualifies: ({ activeDays }: BadgeContext) => activeDays >= 7,
  },
  {
    id: "marathon-month",
    mark: "30D",
    name: "Marathon Month",
    description: "Stayed active for at least 30 days.",
    tone: "amber",
    qualifies: ({ activeDays }: BadgeContext) => activeDays >= 30,
  },
  {
    id: "streak-7",
    mark: "S7",
    name: "Streak 7",
    description: "Reached a 7-day streak.",
    tone: "sky",
    qualifies: ({ longestStreak }: BadgeContext) => longestStreak >= 7,
  },
  {
    id: "streak-30",
    mark: "S30",
    name: "Streak 30",
    description: "Reached a 30-day streak.",
    tone: "violet",
    qualifies: ({ longestStreak }: BadgeContext) => longestStreak >= 30,
  },
  {
    id: "multi-client",
    mark: "3+",
    name: "Multi-Client",
    description: "Used at least 3 coding clients.",
    tone: "emerald",
    qualifies: ({ clientCount }: BadgeContext) => clientCount >= 3,
  },
  {
    id: "model-explorer",
    mark: "10M",
    name: "Model Explorer",
    description: "Used at least 10 different models.",
    tone: "violet",
    qualifies: ({ modelCount }: BadgeContext) => modelCount >= 10,
  },
  {
    id: "efficient",
    mark: "50%",
    name: "Efficient",
    description: "Maintained a 50%+ cache hit rate.",
    tone: "emerald",
    qualifies: ({ cacheHitRate }: BadgeContext) => cacheHitRate >= 50,
  },
  {
    id: "billion-club",
    mark: "1B",
    name: "1B Club",
    description: "Surpassed 1 billion total tokens.",
    tone: "amber",
    qualifies: ({ totalTokens }: BadgeContext) => totalTokens >= 1_000_000_000,
  },
  {
    id: "ten-billion-club",
    mark: "10B",
    name: "10B Club",
    description: "Surpassed 10 billion total tokens.",
    tone: "rose",
    qualifies: ({ totalTokens }: BadgeContext) => totalTokens >= 10_000_000_000,
  },
] as const;

export function getEarnedBadges({ context }: { context: BadgeContext }) {
  return badgeDefinitions
    .filter((badge) => badge.qualifies(context))
    .map(({ id, mark, name, description, tone }) => ({
      id,
      mark,
      name,
      description,
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
