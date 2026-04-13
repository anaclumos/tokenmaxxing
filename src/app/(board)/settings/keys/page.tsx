import { eq } from "drizzle-orm";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { requireOrg } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { providerKeys } from "@/lib/db/schema";
import {
  removeProviderKeyAction,
  saveProviderKeyAction,
} from "@/lib/board/actions";

const PROVIDERS = [
  { id: "openai", name: "OpenAI", placeholder: "sk-..." },
  { id: "anthropic", name: "Anthropic", placeholder: "sk-ant-..." },
  { id: "google", name: "Google AI", placeholder: "AIza..." },
] as const;

type KeysPageProps = {
  searchParams: Promise<{
    error?: string;
    provider?: string;
    status?: string;
  }>;
};

export default async function KeysPage({ searchParams }: KeysPageProps) {
  const [{ orgId }, flash] = await Promise.all([requireOrg(), searchParams]);
  const db = getDb();
  const rows = await db.query.providerKeys.findMany({
    columns: {
      provider: true,
      validatedAt: true,
      createdAt: true,
    },
    where: eq(providerKeys.orgId, orgId),
    orderBy: (table, { asc }) => [asc(table.provider)],
  });
  const keys = rows.map((row) => ({
    ...row,
    maskedKey: "••••••••",
  }));
  const providerName =
    PROVIDERS.find((provider) => provider.id === flash.provider)?.name ??
    flash.provider;
  const successMessage =
    flash.status === "saved"
      ? `${providerName} key saved.`
      : flash.status === "removed"
        ? `${providerName} key removed.`
        : null;

  const getKeyStatus = (providerId: string) =>
    keys.find((key) => key.provider === providerId);

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

      {flash.error && (
        <Alert variant="destructive">
          <AlertDescription>{flash.error}</AlertDescription>
        </Alert>
      )}
      {successMessage && (
        <Alert>
          <AlertDescription>{successMessage}</AlertDescription>
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
                  <form action={removeProviderKeyAction}>
                    <input type="hidden" name="provider" value={provider.id} />
                    <SubmitButton
                      className="text-destructive"
                      pendingText="Removing..."
                      size="sm"
                      type="submit"
                      variant="ghost"
                    >
                      Remove
                    </SubmitButton>
                  </form>
                </div>
              )}

              <form action={saveProviderKeyAction} className="flex gap-2">
                <input type="hidden" name="provider" value={provider.id} />
                <Input
                  id={provider.id}
                  name="apiKey"
                  type="password"
                  placeholder={
                    existing
                      ? "Replace with new key..."
                      : provider.placeholder
                  }
                  className="flex-1"
                  aria-label={`${provider.name} API key`}
                />
                <SubmitButton
                  pendingText="Saving..."
                  type="submit"
                  variant="outline"
                >
                  Save
                </SubmitButton>
              </form>
            </div>
          );
        })}
      </div>
    </div>
  );
}
