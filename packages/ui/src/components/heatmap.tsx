export type HeatmapDatum = {
  date: string;
  value: number;
  cost?: number;
  sessions?: number;
};

export type HeatmapTooltipPayload = {
  datum: HeatmapDatum;
  clientX: number;
  clientY: number;
};

type GridCell = { date: Date; col: number; row: number };
type ThemeConfig = { label: string; hue: number; chroma: number };

export const heatmapThemeNames = ["green", "blue", "purple", "halloween", "mono"] as const;

export type HeatmapTheme = (typeof heatmapThemeNames)[number];

export const heatmapThemes: Record<HeatmapTheme, ThemeConfig> = {
  green: { label: "Green", hue: 155, chroma: 0.17 },
  blue: { label: "Blue", hue: 245, chroma: 0.16 },
  purple: { label: "Purple", hue: 310, chroma: 0.17 },
  halloween: { label: "Halloween", hue: 45, chroma: 0.19 },
  mono: { label: "Mono", hue: 0, chroma: 0 },
};

export const heatmapViewNames = ["flat", "iso"] as const;

export type HeatmapView = (typeof heatmapViewNames)[number];

export const heatmapViews: Record<HeatmapView, { label: string }> = {
  flat: { label: "2D" },
  iso: { label: "3D" },
};

const LEVELS = [
  { lightness: 0.43, chroma: 0.45 },
  { lightness: 0.54, chroma: 0.68 },
  { lightness: 0.64, chroma: 0.84 },
  { lightness: 0.73, chroma: 1 },
] as const;

const CELL_SIZE = 12;
const CELL_GAP = 2;
const BAR_DEPTH_X = 6;
const BAR_DEPTH_Y = 4;
const MAX_BAR_HEIGHT = 18;

export function parseHeatmapTheme(value?: string): HeatmapTheme {
  return heatmapThemeNames.find((theme) => theme === value) ?? "green";
}

export function parseHeatmapView(value?: string): HeatmapView {
  return heatmapViewNames.find((view) => view === value) ?? "flat";
}

function getLevel(value: number, max: number) {
  if (value <= 0) return undefined;
  const ratio = max === 0 ? 0 : value / max;
  if (ratio < 0.25) return LEVELS[0];
  if (ratio < 0.5) return LEVELS[1];
  if (ratio < 0.75) return LEVELS[2];
  return LEVELS[3];
}

function getFlatFill({ value, max, theme }: { value: number; max: number; theme: HeatmapTheme }) {
  if (value === 0) return "var(--muted)";
  const level = getLevel(value, max);
  const palette = heatmapThemes[theme];
  if (!level) return "var(--muted)";
  return `oklch(${level.lightness} ${palette.chroma * level.chroma} ${palette.hue})`;
}

function getBarFaces({ value, max, theme }: { value: number; max: number; theme: HeatmapTheme }) {
  if (value === 0) {
    return {
      front: "var(--muted)",
      top: "var(--muted)",
      side: "var(--muted)",
    };
  }

  const level = getLevel(value, max);
  const palette = heatmapThemes[theme];
  if (!level) {
    return {
      front: "var(--muted)",
      top: "var(--muted)",
      side: "var(--muted)",
    };
  }

  const chroma = palette.chroma * level.chroma;

  return {
    front: `oklch(${level.lightness} ${chroma} ${palette.hue})`,
    top: `oklch(${Math.min(level.lightness + 0.08, 0.92)} ${chroma} ${palette.hue})`,
    side: `oklch(${Math.max(level.lightness - 0.09, 0.22)} ${chroma} ${palette.hue})`,
  };
}

function getBarHeight({ value, max }: { value: number; max: number }) {
  if (value === 0) return 2;
  const ratio = max === 0 ? 0 : value / max;
  return Math.max(3, Math.round(4 + ratio * MAX_BAR_HEIGHT));
}

function buildGrid(year?: number) {
  const cells: GridCell[] = [];

  if (year) {
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

function buildTooltip(data: HeatmapDatum) {
  const details = [`${data.date}`, `${data.value.toLocaleString()} tokens`];

  if (typeof data.cost === "number") {
    details.push(`$${data.cost.toFixed(2)}`);
  }

  if (typeof data.sessions === "number") {
    details.push(`${data.sessions} session${data.sessions === 1 ? "" : "s"}`);
  }

  return details.join("\n");
}

function renderFlatCell({
  cell,
  data,
  max,
  theme,
  selected,
}: {
  cell: GridCell;
  data: HeatmapDatum;
  max: number;
  theme: HeatmapTheme;
  selected: boolean;
}) {
  return (
    <rect
      x={cell.col * (CELL_SIZE + CELL_GAP)}
      y={cell.row * (CELL_SIZE + CELL_GAP)}
      width={CELL_SIZE}
      height={CELL_SIZE}
      rx={2}
      fill={getFlatFill({ value: data.value, max, theme })}
      stroke={selected ? "var(--foreground)" : "none"}
      strokeWidth={selected ? 1.5 : 0}
    />
  );
}

function renderIsoCell({
  cell,
  data,
  max,
  theme,
  selected,
}: {
  cell: GridCell;
  data: HeatmapDatum;
  max: number;
  theme: HeatmapTheme;
  selected: boolean;
}) {
  const x = cell.col * (CELL_SIZE + CELL_GAP);
  const baseY = cell.row * (CELL_SIZE + CELL_GAP) + MAX_BAR_HEIGHT + BAR_DEPTH_Y;
  const barHeight = getBarHeight({ value: data.value, max });
  const topY = baseY - barHeight;
  const rightX = x + CELL_SIZE;
  const { front, top, side } = getBarFaces({ value: data.value, max, theme });
  const stroke = selected ? "var(--foreground)" : "none";
  const strokeWidth = selected ? 1.25 : 0;

  return (
    <>
      <rect
        x={x}
        y={topY}
        width={CELL_SIZE}
        height={barHeight}
        rx={2}
        fill={front}
        stroke={stroke}
        strokeWidth={strokeWidth}
      />
      <polygon
        points={[
          `${x},${topY}`,
          `${rightX},${topY}`,
          `${rightX + BAR_DEPTH_X},${topY - BAR_DEPTH_Y}`,
          `${x + BAR_DEPTH_X},${topY - BAR_DEPTH_Y}`,
        ].join(" ")}
        fill={top}
        stroke={stroke}
        strokeWidth={strokeWidth}
      />
      <polygon
        points={[
          `${rightX},${topY}`,
          `${rightX},${baseY}`,
          `${rightX + BAR_DEPTH_X},${baseY - BAR_DEPTH_Y}`,
          `${rightX + BAR_DEPTH_X},${topY - BAR_DEPTH_Y}`,
        ].join(" ")}
        fill={side}
        stroke={stroke}
        strokeWidth={strokeWidth}
      />
    </>
  );
}

export function ActivityHeatmap({
  data,
  year,
  hrefBuilder,
  selectedDate,
  theme = "green",
  view = "flat",
  onDatumEnter,
  onDatumLeave,
}: {
  data: HeatmapDatum[];
  year?: number;
  hrefBuilder?: (date: string) => string;
  selectedDate?: string;
  theme?: HeatmapTheme;
  view?: HeatmapView;
  onDatumEnter?: (payload: HeatmapTooltipPayload) => void;
  onDatumLeave?: () => void;
}) {
  const dataMap = new Map(data.map((entry) => [entry.date, entry]));
  const max = Math.max(1, ...data.map((entry) => entry.value));
  const { cells, weeks } = buildGrid(year);
  const width = weeks * (CELL_SIZE + CELL_GAP) + (view === "iso" ? BAR_DEPTH_X : 0);
  const height =
    view === "iso"
      ? 7 * (CELL_SIZE + CELL_GAP) + MAX_BAR_HEIGHT + BAR_DEPTH_Y
      : 7 * (CELL_SIZE + CELL_GAP);

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="overflow-visible"
    >
      {cells.map((cell) => {
        const key = cell.date.toISOString().slice(0, 10);
        const entry = dataMap.get(key) ?? { date: key, value: 0 };
        const label = buildTooltip(entry);
        const selected = key === selectedDate;
        const content =
          view === "iso"
            ? renderIsoCell({ cell, data: entry, max, theme, selected })
            : renderFlatCell({ cell, data: entry, max, theme, selected });

        const showTooltip = ({ clientX, clientY }: { clientX: number; clientY: number }) => {
          onDatumEnter?.({
            datum: entry,
            clientX,
            clientY,
          });
        };

        if (!hrefBuilder) {
          return (
            <g
              key={key}
              tabIndex={0}
              aria-label={label}
              onBlur={onDatumLeave}
              onFocus={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                showTooltip({
                  clientX: rect.left + rect.width / 2,
                  clientY: rect.top + rect.height / 2,
                });
              }}
              onPointerEnter={(event) => {
                showTooltip({
                  clientX: event.clientX,
                  clientY: event.clientY,
                });
              }}
              onPointerLeave={onDatumLeave}
              onPointerMove={(event) => {
                showTooltip({
                  clientX: event.clientX,
                  clientY: event.clientY,
                });
              }}
            >
              <title>{label}</title>
              {content}
            </g>
          );
        }

        return (
          <a
            key={key}
            href={hrefBuilder(key)}
            style={{ cursor: "pointer" }}
            aria-label={label}
            onBlur={onDatumLeave}
            onFocus={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              showTooltip({
                clientX: rect.left + rect.width / 2,
                clientY: rect.top + rect.height / 2,
              });
            }}
            onPointerEnter={(event) => {
              showTooltip({
                clientX: event.clientX,
                clientY: event.clientY,
              });
            }}
            onPointerLeave={onDatumLeave}
            onPointerMove={(event) => {
              showTooltip({
                clientX: event.clientX,
                clientY: event.clientY,
              });
            }}
          >
            <g>
              <title>{label}</title>
              {content}
            </g>
          </a>
        );
      })}
    </svg>
  );
}
