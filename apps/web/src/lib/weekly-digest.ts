import { createHmac } from "node:crypto";

const ONE_DAY_MS = 86_400_000;

type WeeklyDigestWindow = {
  startTime: Date;
  endTime: Date;
  startDate: string;
  endDate: string;
  label: string;
};

function shiftUtcDays({ date, days }: { date: Date; days: number }) {
  return new Date(date.getTime() + days * ONE_DAY_MS);
}

function startOfUtcDay({ date }: { date: Date }) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function formatDateKey({ date }: { date: Date }) {
  return date.toISOString().slice(0, 10);
}

function formatWindowLabel({ startTime, endTime }: { startTime: Date; endTime: Date }) {
  const format = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  const endDay = shiftUtcDays({ date: endTime, days: -1 });
  return `${format.format(startTime)} - ${format.format(endDay)}`;
}

function buildWindow({
  startTime,
  endTime,
}: {
  startTime: Date;
  endTime: Date;
}): WeeklyDigestWindow {
  return {
    startTime,
    endTime,
    startDate: formatDateKey({ date: startTime }),
    endDate: formatDateKey({ date: endTime }),
    label: formatWindowLabel({ startTime, endTime }),
  };
}

export function getWeeklyDigestWindows({ now = new Date() }: { now?: Date } = {}) {
  const today = startOfUtcDay({ date: now });
  const daysSinceMonday = (today.getUTCDay() + 6) % 7;
  const currentWeekStart = shiftUtcDays({ date: today, days: -daysSinceMonday });

  return {
    current: buildWindow({
      startTime: shiftUtcDays({ date: currentWeekStart, days: -7 }),
      endTime: currentWeekStart,
    }),
    previous: buildWindow({
      startTime: shiftUtcDays({ date: currentWeekStart, days: -14 }),
      endTime: shiftUtcDays({ date: currentWeekStart, days: -7 }),
    }),
  };
}

export function formatWeekOverWeekChange({
  current,
  previous,
}: {
  current: number;
  previous: number;
}) {
  if (current === previous) return "flat vs previous week";
  if (previous === 0) return current === 0 ? "flat vs previous week" : "new vs previous week";

  const delta = ((current - previous) / previous) * 100;
  const precision = Math.abs(delta) >= 10 ? 0 : 1;
  return `${delta > 0 ? "+" : ""}${delta.toFixed(precision)}% vs previous week`;
}

export function getWeeklyDigestUnsubscribeToken({
  secret,
  userId,
}: {
  secret: string;
  userId: string;
}) {
  return createHmac("sha256", secret).update(`weekly-digest:${userId}`).digest("hex");
}

export function verifyWeeklyDigestUnsubscribeToken({
  secret,
  token,
  userId,
}: {
  secret: string;
  token: string;
  userId: string;
}) {
  return token === getWeeklyDigestUnsubscribeToken({ secret, userId });
}

export function getWeeklyDigestUnsubscribeUrl({
  origin,
  secret,
  userId,
}: {
  origin: string;
  secret: string;
  userId: string;
}) {
  const url = new URL("/api/settings/weekly-digest/unsubscribe", origin);
  url.searchParams.set("user", userId);
  url.searchParams.set("token", getWeeklyDigestUnsubscribeToken({ secret, userId }));
  return url.toString();
}
