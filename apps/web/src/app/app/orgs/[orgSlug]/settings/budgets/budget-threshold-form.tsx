"use client";

import { Button } from "@tokenmaxxing/ui/components/button";
import ky from "ky";
import { useRouter } from "next/navigation";
import { useState } from "react";

type Member = {
  id: string;
  username: string;
};

export function BudgetThresholdForm({ members, orgId }: { members: Member[]; orgId: string }) {
  const router = useRouter();
  const [scope, setScope] = useState<"org" | "member">("org");
  const [userId, setUserId] = useState(members[0]?.id ?? "");
  const [period, setPeriod] = useState<"daily" | "weekly" | "monthly">("daily");
  const [thresholdUsd, setThresholdUsd] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [emailNotify, setEmailNotify] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const needsMember = scope === "member";
  const canSubmit = thresholdUsd.length > 0 && (!needsMember || userId.length > 0);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;

    setLoading(true);
    setMessage(null);

    await ky.post(`/api/orgs/${orgId}/budgets`, {
      json: {
        period,
        thresholdUsd: Number(thresholdUsd),
        userId: needsMember ? userId : null,
        webhookUrl: webhookUrl || undefined,
        emailNotify,
      },
    });

    setThresholdUsd("");
    setWebhookUrl("");
    setEmailNotify(false);
    setMessage("Budget threshold saved.");
    setLoading(false);
    router.refresh();
  }

  return (
    <form className="space-y-4" onSubmit={submit}>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-2 text-sm">
          <span className="font-medium">Scope</span>
          <select
            value={scope}
            onChange={(event) => setScope(event.target.value === "member" ? "member" : "org")}
            className="h-10 w-full rounded-lg border border-border bg-background px-3"
          >
            <option value="org">Org-wide</option>
            <option value="member">Per member</option>
          </select>
        </label>

        <label className="space-y-2 text-sm">
          <span className="font-medium">Period</span>
          <select
            value={period}
            onChange={(event) => setPeriod(event.target.value as "daily" | "weekly" | "monthly")}
            className="h-10 w-full rounded-lg border border-border bg-background px-3"
          >
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>
        </label>
      </div>

      {needsMember && (
        <label className="space-y-2 text-sm">
          <span className="font-medium">Member</span>
          <select
            value={userId}
            onChange={(event) => setUserId(event.target.value)}
            className="h-10 w-full rounded-lg border border-border bg-background px-3"
          >
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.username}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-2 text-sm">
          <span className="font-medium">Threshold (USD)</span>
          <input
            type="number"
            min="0.01"
            step="0.01"
            inputMode="decimal"
            value={thresholdUsd}
            onChange={(event) => setThresholdUsd(event.target.value)}
            placeholder="100"
            className="h-10 w-full rounded-lg border border-border bg-background px-3"
          />
        </label>

        <label className="space-y-2 text-sm">
          <span className="font-medium">Webhook URL</span>
          <input
            type="url"
            value={webhookUrl}
            onChange={(event) => setWebhookUrl(event.target.value)}
            placeholder="https://example.com/webhook"
            className="h-10 w-full rounded-lg border border-border bg-background px-3"
          />
        </label>
      </div>

      <label className="flex items-center gap-3 text-sm">
        <input
          type="checkbox"
          checked={emailNotify}
          onChange={(event) => setEmailNotify(event.target.checked)}
          className="size-4 rounded border border-border"
        />
        <span>Email members when this threshold is crossed</span>
      </label>

      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={loading || !canSubmit}>
          {loading ? "Saving..." : "Save threshold"}
        </Button>
        {message && <p className="text-sm text-muted-foreground">{message}</p>}
      </div>
    </form>
  );
}
