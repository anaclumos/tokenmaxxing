"use client";

import { Button } from "@tokenmaxxing/ui/components/button";
import ky from "ky";
import { useState } from "react";

export function WeeklyDigestToggle({ initial }: { initial: boolean }) {
  const [enabled, setEnabled] = useState(initial);
  const [loading, setLoading] = useState(false);

  async function toggle() {
    setLoading(true);
    await ky.put("/api/settings/weekly-digest", {
      json: { weeklyDigestEnabled: !enabled },
    });
    setEnabled(!enabled);
    setLoading(false);
  }

  return (
    <div className="flex items-center justify-between">
      <div>
        <p className="text-sm font-medium">
          Weekly digest is {enabled ? "on" : "off"}
        </p>
        <p className="text-xs text-muted-foreground">
          {enabled
            ? "You'll get a Monday summary email with tokens, cost, streak, and rank movement."
            : "Turn on a Monday summary email with your weekly token usage highlights."}
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
