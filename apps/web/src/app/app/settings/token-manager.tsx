"use client";

import { Badge } from "@tokenmaxxing/ui/components/badge";
import { Button } from "@tokenmaxxing/ui/components/button";
import { useState, useEffect } from "react";

type Token = {
  id: string;
  prefix: string;
  name: string;
  lastUsedAt: string | null;
  createdAt: string;
};

export function TokenManager() {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch("/api/tokens")
      .then((r) => r.json())
      .then((d: { tokens: Token[] }) => setTokens(d.tokens));
  }, []);

  async function generate() {
    setLoading(true);
    const res = await fetch("/api/tokens", { method: "POST" });
    const data = (await res.json()) as { token: string };
    setNewToken(data.token);
    // Refresh list
    const listRes = await fetch("/api/tokens");
    const listData = (await listRes.json()) as { tokens: Token[] };
    setTokens(listData.tokens);
    setLoading(false);
  }

  return (
    <div>
      {newToken && (
        <div className="mb-4 rounded border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950 px-4 py-3">
          <p className="mb-1 text-sm font-medium text-green-700 dark:text-green-400">
            Token created. Copy it now - it won't be shown again.
          </p>
          <code className="block break-all font-mono text-sm text-green-600 dark:text-green-300">
            {newToken}
          </code>
          <p className="mt-2 text-xs text-muted-foreground">
            Run:{" "}
            <code className="font-mono">
              tokenmaxxing login --token {newToken}
            </code>
          </p>
        </div>
      )}

      <div className="mb-4 space-y-2">
        {tokens.map((t) => (
          <div
            key={t.id}
            className="flex items-center justify-between rounded border border-border px-3 py-2"
          >
            <div className="flex items-center gap-2">
              <code className="font-mono text-sm">{t.prefix}...</code>
              <Badge variant="secondary" className="text-xs">
                {t.name}
              </Badge>
            </div>
            <span className="text-xs text-muted-foreground">
              {t.lastUsedAt
                ? `Used ${new Date(t.lastUsedAt).toLocaleDateString()}`
                : "Never used"}
            </span>
          </div>
        ))}
        {tokens.length === 0 && (
          <p className="text-sm text-muted-foreground">No tokens yet.</p>
        )}
      </div>

      <Button onClick={generate} disabled={loading} size="sm">
        {loading ? "Generating..." : "Generate new token"}
      </Button>
    </div>
  );
}
