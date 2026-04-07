import { formatTokens } from "@tokenmaxxing/shared/types";

type WeeklyDigestEmailProps = {
  username: string;
  weekLabel: string;
  totalTokens: number;
  totalCost: number;
  sessions: number;
  tokenChange: string;
  costChange: string;
  sessionChange: string;
  currentStreak: number;
  rankChange: string | null;
  topModels: string[];
  topClients: string[];
  dashboardUrl: string;
  unsubscribeUrl: string;
};

const shellStyle = {
  margin: "0",
  backgroundColor: "#07111f",
  color: "#f7fbff",
  fontFamily: "system-ui, sans-serif",
};

const cardStyle = {
  maxWidth: "640px",
  margin: "0 auto",
  padding: "40px 24px",
};

const panelStyle = {
  border: "1px solid #1d2c45",
  borderRadius: "24px",
  backgroundColor: "#10192d",
  padding: "32px",
};

const metricLabelStyle = {
  margin: "0 0 6px",
  color: "#8ea3c7",
  fontSize: "13px",
  letterSpacing: "0.08em",
  textTransform: "uppercase" as const,
};

const metricValueStyle = {
  margin: "0",
  color: "#f7fbff",
  fontFamily: "monospace",
  fontSize: "28px",
  fontWeight: "700",
};

const metricChangeStyle = {
  margin: "8px 0 0",
  color: "#8ea3c7",
  fontFamily: "monospace",
  fontSize: "13px",
};

export function WeeklyDigestEmail({
  username,
  weekLabel,
  totalTokens,
  totalCost,
  sessions,
  tokenChange,
  costChange,
  sessionChange,
  currentStreak,
  rankChange,
  topModels,
  topClients,
  dashboardUrl,
  unsubscribeUrl,
}: WeeklyDigestEmailProps) {
  const streakLabel =
    currentStreak > 0
      ? `You are on a ${currentStreak}-day streak.`
      : "No active streak right now. Upload fresh usage to restart it.";

  const models = topModels.length > 0 ? topModels : ["No model activity this week"];
  const clients = topClients.length > 0 ? topClients : ["No client activity this week"];

  return (
    <html>
      <body style={shellStyle}>
        <div style={cardStyle}>
          <div style={panelStyle}>
            <p style={{ margin: "0 0 12px", color: "#8fb8ff", fontFamily: "monospace" }}>
              tokenmaxx.ing
            </p>
            <h1 style={{ margin: "0", fontSize: "38px", lineHeight: "1.1" }}>
              {username}&apos;s weekly digest
            </h1>
            <p style={{ margin: "12px 0 32px", color: "#8ea3c7", fontSize: "16px" }}>{weekLabel}</p>

            <div style={{ display: "grid", gap: "16px", marginBottom: "28px" }}>
              <div>
                <p style={metricLabelStyle}>Tokens</p>
                <p style={metricValueStyle}>{formatTokens(totalTokens)}</p>
                <p style={metricChangeStyle}>{tokenChange}</p>
              </div>

              <div>
                <p style={metricLabelStyle}>Cost</p>
                <p style={metricValueStyle}>${totalCost.toFixed(2)}</p>
                <p style={metricChangeStyle}>{costChange}</p>
              </div>

              <div>
                <p style={metricLabelStyle}>Messages</p>
                <p style={metricValueStyle}>{sessions.toLocaleString()}</p>
                <p style={metricChangeStyle}>{sessionChange}</p>
              </div>
            </div>

            <div style={{ marginBottom: "24px" }}>
              <p style={metricLabelStyle}>Current streak</p>
              <p style={{ margin: "0", color: "#d7e9ff", fontSize: "16px" }}>{streakLabel}</p>
            </div>

            {rankChange && (
              <div style={{ marginBottom: "24px" }}>
                <p style={metricLabelStyle}>Leaderboard</p>
                <p style={{ margin: "0", color: "#d7e9ff", fontSize: "16px" }}>{rankChange}</p>
              </div>
            )}

            <div style={{ marginBottom: "24px" }}>
              <p style={metricLabelStyle}>Top models</p>
              <ul style={{ margin: "12px 0 0", paddingLeft: "20px", color: "#d7e9ff" }}>
                {models.map((model) => (
                  <li key={model} style={{ marginBottom: "8px" }}>
                    {model}
                  </li>
                ))}
              </ul>
            </div>

            <div style={{ marginBottom: "32px" }}>
              <p style={metricLabelStyle}>Top clients</p>
              <ul style={{ margin: "12px 0 0", paddingLeft: "20px", color: "#d7e9ff" }}>
                {clients.map((client) => (
                  <li key={client} style={{ marginBottom: "8px" }}>
                    {client}
                  </li>
                ))}
              </ul>
            </div>

            <a
              href={dashboardUrl}
              style={{
                display: "inline-block",
                borderRadius: "999px",
                backgroundColor: "#2b7fff",
                color: "#f7fbff",
                fontWeight: "700",
                padding: "12px 18px",
                textDecoration: "none",
              }}
            >
              View your full dashboard
            </a>

            <p style={{ margin: "28px 0 0", color: "#8ea3c7", fontSize: "13px", lineHeight: 1.6 }}>
              You are receiving this because weekly digest is enabled in tokenmaxx.ing settings.{" "}
              <a href={unsubscribeUrl} style={{ color: "#8fb8ff" }}>
                Unsubscribe
              </a>
            </p>
          </div>
        </div>
      </body>
    </html>
  );
}
