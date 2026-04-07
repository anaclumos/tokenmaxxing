"use client";

import { Button } from "@tokenmaxxing/ui/components/button";
import { useState } from "react";

export function ShareButton({ path, text }: { path: string; text: string }) {
  const [copied, setCopied] = useState(false);

  async function share() {
    const url = new URL(path, window.location.origin).toString();

    if (navigator.share) {
      await navigator.share({ url, text });
      return;
    }

    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Button variant="outline" size="sm" onClick={share}>
      {copied ? "Copied!" : "Share"}
    </Button>
  );
}
