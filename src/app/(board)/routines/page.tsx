"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { useOrgId } from "@/hooks/use-org-id";
import { useCallback, useEffect, useState } from "react";

type Routine = {
  id: string;
  name: string;
  description: string | null;
  agentId: string;
  status: string;
  createdAt: string;
};

export default function RoutinesPage() {
  const orgId = useOrgId();
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  const fetchRoutines = useCallback(async () => {
    if (!orgId) return;
    const res = await fetch(`/api/orgs/${orgId}/routines`);
    if (res.ok) setRoutines(await res.json());
  }, [orgId]);

  useEffect(() => {
    fetchRoutines();
  }, [fetchRoutines]);

  const handleCreate = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!orgId) return;
    setCreating(true);
    const formData = Object.fromEntries(new FormData(e.currentTarget));

    const res = await fetch(`/api/orgs/${orgId}/routines`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: formData.name,
        description: formData.description || undefined,
        agentId: formData.agentId,
        triggers: formData.cron
          ? [{ cronExpression: formData.cron as string }]
          : undefined,
      }),
    });

    if (res.ok) {
      setOpen(false);
      await fetchRoutines();
    }
    setCreating(false);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-balance">
            Routines
          </h2>
          <p className="mt-1 text-sm text-muted-foreground text-pretty">
            Scheduled agent work on a cron schedule.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>New Routine</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Routine</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleCreate} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  name="name"
                  placeholder="Daily standup report"
                  required
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  name="description"
                  placeholder="What this routine does..."
                  rows={2}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="agentId">Agent ID</Label>
                <Input
                  id="agentId"
                  name="agentId"
                  placeholder="UUID of the agent"
                  required
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="cron">Cron Expression</Label>
                <Input
                  id="cron"
                  name="cron"
                  placeholder="0 9 * * 1-5"
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
                  {creating ? "Creating..." : "Create Routine"}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {routines.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16">
          <p className="text-sm text-muted-foreground text-pretty">
            No routines configured. Set up recurring agent tasks.
          </p>
        </div>
      ) : (
        <div className="space-y-px rounded-lg border border-border/50 overflow-hidden">
          {routines.map((routine) => (
            <div
              key={routine.id}
              className="flex items-center justify-between gap-4 p-4"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{routine.name}</p>
                {routine.description && (
                  <p className="mt-0.5 text-xs text-muted-foreground truncate">
                    {routine.description}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <span className="text-xs text-muted-foreground font-mono">
                  {routine.agentId.slice(0, 8)}
                </span>
                <Badge
                  variant={routine.status === "active" ? "secondary" : "outline"}
                  className="text-xs"
                >
                  {routine.status}
                </Badge>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
