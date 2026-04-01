"use client";

import { Button } from "@tokenmaxxing/ui/components/button";
import { useState } from "react";

export function ShareButton({ username, tokens, cost }: {
  username: string;
  tokens: string;
  cost: string;
}) {
  const [copied, setCopied] = useState(false);

  async function share() {
    const url = `${window.location.origin}/u/${username}`;
    const text = `${username}'s tokenmaxx.ing stats: ${tokens} tokens, $${cost} spent`;

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
