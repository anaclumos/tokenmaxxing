"use client";

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

type Goal = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  createdAt: string;
};

export default function GoalsPage() {
  const orgId = useOrgId();
  const [goals, setGoals] = useState<Goal[]>([]);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  const fetchGoals = useCallback(async () => {
    if (!orgId) return;
    const res = await fetch(`/api/orgs/${orgId}/goals`);
    if (res.ok) setGoals(await res.json());
  }, [orgId]);

  useEffect(() => {
    fetchGoals();
  }, [fetchGoals]);

  const handleCreate = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!orgId) return;
    setCreating(true);
    const data = Object.fromEntries(new FormData(e.currentTarget));

    const res = await fetch(`/api/orgs/${orgId}/goals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });

    if (res.ok) {
      setOpen(false);
      await fetchGoals();
    }
    setCreating(false);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-balance">
            Goals
          </h2>
          <p className="mt-1 text-sm text-muted-foreground text-pretty">
            Company goals that drive agent work.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>New Goal</Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Create Goal</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleCreate} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="title">Title</Label>
                <Input
                  id="title"
                  name="title"
                  placeholder="Build the #1 AI note-taking app"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  name="description"
                  placeholder="What does success look like?"
                  rows={3}
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
                  {creating ? "Creating..." : "Create Goal"}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {goals.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16">
          <p className="text-sm text-muted-foreground text-pretty">
            No goals yet. Define your company mission to align agent work.
          </p>
        </div>
      ) : (
        <div className="space-y-px rounded-lg border border-border/50 overflow-hidden">
          {goals.map((goal) => (
            <div
              key={goal.id}
              className="p-4 hover:bg-muted/50 transition-colors"
            >
              <p className="text-sm font-medium">{goal.title}</p>
              {goal.description && (
                <p className="mt-1 text-xs text-muted-foreground text-pretty line-clamp-2">
                  {goal.description}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
