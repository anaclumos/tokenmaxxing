type DayData = { date: string; value: number };

export const heatmapThemes = {
  green:  { hue: 155, label: "Green" },
  blue:   { hue: 230, label: "Blue" },
  purple: { hue: 290, label: "Purple" },
  orange: { hue: 30,  label: "Orange" },
  mono:   { hue: 0,   label: "Mono" },
} as const;

export type HeatmapTheme = keyof typeof heatmapThemes;

const LEVELS = [
  { l: 0.40, c: 0.10 },
  { l: 0.50, c: 0.13 },
  { l: 0.60, c: 0.15 },
  { l: 0.70, c: 0.17 },
] as const;

function getColor(value: number, max: number, hue: number, chroma: number): string {
  if (value === 0) return "var(--muted)";
  const ratio = value / max;
  const level = ratio < 0.25 ? 0 : ratio < 0.5 ? 1 : ratio < 0.75 ? 2 : 3;
  const { l, c } = LEVELS[level];
  return `oklch(${l} ${c * chroma} ${hue})`;
}

function buildGrid(year?: number) {
  const cells: Array<{ date: Date; col: number; row: number }> = [];

  if (year) {
    // Calendar year: Jan 1 to Dec 31 (or today if current year)
    const start = new Date(year, 0, 1);
    const now = new Date();
    const end = year === now.getFullYear() ? now : new Date(year, 11, 31);

    let col = 0;
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const day = d.getDay();
      if (day === 0 && d > start) col++;
      cells.push({ date: new Date(d), col, row: day });
    }

    return { cells, weeks: col + 1 };
  }

  // Default: 52 weeks ending today
  const today = new Date();
  const weeks = 52;
  for (let w = weeks - 1; w >= 0; w--) {
    for (let d = 0; d < 7; d++) {
      const date = new Date(today);
      date.setDate(date.getDate() - (w * 7 + (6 - d)));
      cells.push({ date, col: weeks - 1 - w, row: d });
    }
  }

  return { cells, weeks };
}

export function ActivityHeatmap({ data, year, hrefBuilder, selectedDate, theme = "green" }: {
  data: DayData[];
  year?: number;
  hrefBuilder?: (date: string) => string;
  selectedDate?: string;
  theme?: HeatmapTheme;
}) {
  const dataMap = new Map(data.map((d) => [d.date, d.value]));
  const max = Math.max(1, ...data.map((d) => d.value));
  const { hue } = heatmapThemes[theme];
  const chroma = theme === "mono" ? 0 : 1;

  const { cells, weeks } = buildGrid(year);

  const cellSize = 12;
  const gap = 2;
  const width = weeks * (cellSize + gap);
  const height = 7 * (cellSize + gap);

  return (
    <svg width={width} height={height} className="overflow-visible">
      {cells.map((c) => {
        const key = c.date.toISOString().slice(0, 10);
        const value = dataMap.get(key) ?? 0;
        const isSelected = key === selectedDate;
        const cell = (
          <rect
            x={c.col * (cellSize + gap)}
            y={c.row * (cellSize + gap)}
            width={cellSize}
            height={cellSize}
            rx={2}
            fill={getColor(value, max, hue, chroma)}
            stroke={isSelected ? "var(--foreground)" : "none"}
            strokeWidth={isSelected ? 1.5 : 0}
          >
            <title>{`${key}: ${value.toLocaleString()} tokens`}</title>
          </rect>
        );
        if (!hrefBuilder) return <g key={key}>{cell}</g>;
        return (
          <a key={key} href={hrefBuilder(key)} style={{ cursor: "pointer" }}>
            {cell}
          </a>
        );
      })}
    </svg>
  );
}
