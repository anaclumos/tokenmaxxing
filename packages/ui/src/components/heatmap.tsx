type DayData = { date: string; value: number };

function getColor(value: number, max: number): string {
  if (value === 0) return "var(--muted)";
  const ratio = value / max;
  if (ratio < 0.25) return "oklch(0.45 0.1 165)";
  if (ratio < 0.5) return "oklch(0.55 0.13 165)";
  if (ratio < 0.75) return "oklch(0.65 0.15 165)";
  return "oklch(0.75 0.17 165)";
}

export function ActivityHeatmap({ data, weeks = 52 }: { data: DayData[]; weeks?: number }) {
  const dataMap = new Map(data.map((d) => [d.date, d.value]));
  const max = Math.max(1, ...data.map((d) => d.value));

  // Build grid: 52 weeks x 7 days, ending today
  const today = new Date();
  const cells: Array<{ date: string; value: number; col: number; row: number }> = [];

  for (let w = weeks - 1; w >= 0; w--) {
    for (let d = 0; d < 7; d++) {
      const date = new Date(today);
      date.setDate(date.getDate() - (w * 7 + (6 - d)));
      const key = date.toISOString().slice(0, 10);
      cells.push({ date: key, value: dataMap.get(key) ?? 0, col: weeks - 1 - w, row: d });
    }
  }

  const cellSize = 12;
  const gap = 2;
  const width = weeks * (cellSize + gap);
  const height = 7 * (cellSize + gap);

  return (
    <svg width={width} height={height} className="overflow-visible">
      {cells.map((c) => (
        <rect
          key={c.date}
          x={c.col * (cellSize + gap)}
          y={c.row * (cellSize + gap)}
          width={cellSize}
          height={cellSize}
          rx={2}
          fill={getColor(c.value, max)}
        >
          <title>{`${c.date}: ${c.value.toLocaleString()} tokens`}</title>
        </rect>
      ))}
    </svg>
  );
}
