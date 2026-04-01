"use client";

import { Button } from "@tokenmaxxing/ui/components/button";
import { useState } from "react";

export function PrivacyToggle({ initial }: { initial: boolean }) {
  const [enabled, setEnabled] = useState(initial);
  const [loading, setLoading] = useState(false);

  async function toggle() {
    setLoading(true);
    const res = await fetch("/api/settings/privacy", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ privacyMode: !enabled }),
    });
    if (res.ok) setEnabled(!enabled);
    setLoading(false);
  }

  return (
    <div className="flex items-center justify-between">
      <div>
        <p className="text-sm font-medium">
          Privacy mode is {enabled ? "on" : "off"}
        </p>
        <p className="text-xs text-muted-foreground">
          {enabled
            ? "Your profile, leaderboard entry, badge, and card are hidden."
            : "Your profile and stats are publicly visible."}
        </p>
      </div>
      <Button
        variant={enabled ? "default" : "outline"}
        size="sm"
        onClick={toggle}
        disabled={loading}
      >
        {loading ? "Saving..." : enabled ? "Disable" : "Enable"}
      </Button>
    </div>
  );
}
