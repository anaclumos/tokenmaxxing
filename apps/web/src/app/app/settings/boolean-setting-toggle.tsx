"use client";

import { Button } from "@tokenmaxxing/ui/components/button";
import ky from "ky";
import { useState } from "react";

export function BooleanSettingToggle({
  initial,
  label,
  onDescription,
  offDescription,
  endpoint,
  bodyKey,
}: {
  initial: boolean;
  label: string;
  onDescription: string;
  offDescription: string;
  endpoint: string;
  bodyKey: string;
}) {
  const [enabled, setEnabled] = useState(initial);
  const [loading, setLoading] = useState(false);

  async function toggle() {
    setLoading(true);
    await ky.put(endpoint, {
      json: { [bodyKey]: !enabled },
    });
    setEnabled(!enabled);
    setLoading(false);
  }

  return (
    <div className="flex items-center justify-between">
      <div>
        <p className="text-sm font-medium">
          {label} is {enabled ? "on" : "off"}
        </p>
        <p className="text-xs text-muted-foreground">{enabled ? onDescription : offDescription}</p>
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
