"use client";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useOrgId } from "@/hooks/use-org-id";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

type Agent = {
  id: string;
  name: string;
  shortname: string;
  model: string;
  provider: string;
  role: string;
  title: string;
  status: string;
  monthlyBudgetCents: number | null;
  createdAt: string;
};

export default function AgentsPage() {
  const orgId = useOrgId();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [provider, setProvider] = useState("");

  const fetchAgents = useCallback(async () => {
    if (!orgId) return;
    const res = await fetch(`/api/orgs/${orgId}/agents`);
    if (res.ok) setAgents(await res.json());
  }, [orgId]);

  useEffect(() => {
    fetchAgents();
  }, [fetchAgents]);

  const handleCreate = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!orgId) return;
    setCreating(true);
    const formData = Object.fromEntries(new FormData(e.currentTarget));

    const res = await fetch(`/api/orgs/${orgId}/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...formData,
        provider,
        monthlyBudgetCents: formData.monthlyBudgetCents
          ? Number(formData.monthlyBudgetCents)
          : undefined,
      }),
    });

    if (res.ok) {
      setOpen(false);
      setProvider("");
      await fetchAgents();
    }
    setCreating(false);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-balance">
            Agents
          </h2>
          <p className="mt-1 text-sm text-muted-foreground text-pretty">
            Your AI team members and their roles.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>New Agent</Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Create Agent</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleCreate} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="name">Name</Label>
                  <Input
                    id="name"
                    name="name"
                    placeholder="Frontend Engineer"
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="shortname">Shortname</Label>
                  <Input
                    id="shortname"
                    name="shortname"
                    placeholder="frontend"
                    required
                  />
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="provider">Provider</Label>
                  <Select value={provider} onValueChange={setProvider} required>
                    <SelectTrigger id="provider">
                      <SelectValue placeholder="Select..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="anthropic">Anthropic</SelectItem>
                      <SelectItem value="openai">OpenAI</SelectItem>
                      <SelectItem value="google">Google</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="model">Model</Label>
                  <Input
                    id="model"
                    name="model"
                    placeholder="claude-sonnet-4.6"
                    required
                  />
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="role">Role</Label>
                  <Input
                    id="role"
                    name="role"
                    placeholder="engineer"
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="title">Title</Label>
                  <Input
                    id="title"
                    name="title"
                    placeholder="Senior Frontend Engineer"
                    required
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="systemPrompt">System Prompt</Label>
                <Textarea
                  id="systemPrompt"
                  name="systemPrompt"
                  placeholder="You are a senior frontend engineer..."
                  rows={3}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="monthlyBudgetCents">
                  Monthly Budget (cents)
                </Label>
                <Input
                  id="monthlyBudgetCents"
                  name="monthlyBudgetCents"
                  type="number"
                  placeholder="10000"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setOpen(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={creating}>
                  {creating ? "Creating..." : "Create Agent"}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {agents.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16">
          <p className="text-sm text-muted-foreground text-pretty">
            No agents yet. Create your first agent to start building your team.
          </p>
        </div>
      ) : (
        <div className="space-y-px rounded-lg border border-border/50 overflow-hidden">
          {agents.map((agent, i) => (
            <Link
              key={agent.id}
              href={`/agents/${agent.id}`}
              className="flex items-center justify-between gap-4 p-4 hover:bg-muted/50 transition-colors"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium truncate">{agent.name}</p>
                  <Badge variant="secondary" className="text-xs shrink-0">
                    {agent.role}
                  </Badge>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground truncate">
                  {agent.provider}/{agent.model}
                </p>
              </div>

              <div className="flex items-center gap-3 shrink-0">
                {agent.monthlyBudgetCents && (
                  <span className="text-xs text-muted-foreground font-mono tabular-nums">
                    ${(agent.monthlyBudgetCents / 100).toFixed(0)}/mo
                  </span>
                )}
                <Badge
                  variant={
                    agent.status === "active" ? "secondary" : "outline"
                  }
                  className="text-xs"
                >
                  {agent.status}
                </Badge>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
