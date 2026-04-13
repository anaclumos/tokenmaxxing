"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useState, useEffect, useCallback } from "react";
import { useOrgId } from "@/hooks/use-org-id";

const PROVIDERS = [
  { id: "openai", name: "OpenAI", placeholder: "sk-..." },
  { id: "anthropic", name: "Anthropic", placeholder: "sk-ant-..." },
  { id: "google", name: "Google AI", placeholder: "AIza..." },
] as const;

type ProviderKey = {
  provider: string;
  maskedKey: string;
  validatedAt: string | null;
};

export default function KeysPage() {
  const orgId = useOrgId();
  const [saving, setSaving] = useState<string | null>(null);
  const [keys, setKeys] = useState<ProviderKey[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const fetchKeys = useCallback(async () => {
    if (!orgId) return;
    const res = await fetch(`/api/orgs/${orgId}/settings/keys`);
    if (res.ok) setKeys(await res.json());
  }, [orgId]);

  useEffect(() => {
    fetchKeys();
  }, [fetchKeys]);

  const handleSave = async (providerId: string, form: HTMLFormElement) => {
    if (!orgId) return;
    const input = form.querySelector("input") as HTMLInputElement;
    if (!input.value.trim()) return;

    setSaving(providerId);
    setError(null);
    setSuccess(null);

    const res = await fetch(`/api/orgs/${orgId}/settings/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: providerId, apiKey: input.value }),
    });

    if (res.ok) {
      setSuccess(`${providerId} key saved.`);
      input.value = "";
      await fetchKeys();
    } else {
      const data = await res.json().catch(() => null);
      setError(data?.error ?? "Failed to save key.");
    }

    setSaving(null);
  };

  const handleDelete = async (providerId: string) => {
    if (!orgId) return;
    setError(null);
    setSuccess(null);

    const res = await fetch(`/api/orgs/${orgId}/settings/keys`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: providerId }),
    });

    if (res.ok) {
      setSuccess(`${providerId} key removed.`);
      await fetchKeys();
    } else {
      setError("Failed to remove key.");
    }
  };

  const getKeyStatus = (providerId: string) =>
    keys.find((k) => k.provider === providerId);

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight text-balance">
          API Keys
        </h2>
        <p className="mt-1 text-sm text-muted-foreground text-pretty max-w-[65ch]">
          Bring your own LLM provider keys. We encrypt them at rest and only
          use them to run your agents.
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {success && (
        <Alert>
          <AlertDescription>{success}</AlertDescription>
        </Alert>
      )}

      <div className="max-w-lg space-y-6">
        {PROVIDERS.map((provider) => {
          const existing = getKeyStatus(provider.id);

          return (
            <div key={provider.id} className="space-y-2">
              <div className="flex items-center gap-2">
                <Label htmlFor={provider.id} className="text-sm font-medium">
                  {provider.name}
                </Label>
                {existing ? (
                  <Badge variant="secondary" className="text-xs">
                    Configured
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-xs">
                    Not configured
                  </Badge>
                )}
              </div>

              {existing && (
                <div className="flex items-center gap-2 text-sm">
                  <code className="font-mono text-muted-foreground">
                    {existing.maskedKey}
                  </code>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                    onClick={() => handleDelete(provider.id)}
                  >
                    Remove
                  </Button>
                </div>
              )}

              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  handleSave(provider.id, e.currentTarget);
                }}
              >
                <Input
                  id={provider.id}
                  name={provider.id}
                  type="password"
                  placeholder={
                    existing
                      ? "Replace with new key..."
                      : provider.placeholder
                  }
                  className="flex-1"
                  aria-label={`${provider.name} API key`}
                />
                <Button
                  type="submit"
                  variant="outline"
                  disabled={saving === provider.id}
                >
                  {saving === provider.id ? "Saving..." : "Save"}
                </Button>
              </form>
            </div>
          );
        })}
      </div>
    </div>
  );
}
