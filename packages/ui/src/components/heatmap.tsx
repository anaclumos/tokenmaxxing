type DayData = { date: string; value: number };

function getColor(value: number, max: number): string {
  if (value === 0) return "var(--muted)";
  const ratio = value / max;
  if (ratio < 0.25) return "oklch(0.45 0.1 165)";
  if (ratio < 0.5) return "oklch(0.55 0.13 165)";
  if (ratio < 0.75) return "oklch(0.65 0.15 165)";
  return "oklch(0.75 0.17 165)";
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

export function ActivityHeatmap({ data, year }: { data: DayData[]; year?: number }) {
  const dataMap = new Map(data.map((d) => [d.date, d.value]));
  const max = Math.max(1, ...data.map((d) => d.value));

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
        return (
          <rect
            key={key}
            x={c.col * (cellSize + gap)}
            y={c.row * (cellSize + gap)}
            width={cellSize}
            height={cellSize}
            rx={2}
            fill={getColor(value, max)}
          >
            <title>{`${key}: ${value.toLocaleString()} tokens`}</title>
          </rect>
        );
      })}
    </svg>
  );
}
