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

type Skill = {
  id: string;
  name: string;
  slug: string;
  content: string;
  sourceType: string;
  sourceUrl: string | null;
  createdAt: string;
};

export default function SkillsPage() {
  const orgId = useOrgId();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  const fetchSkills = useCallback(async () => {
    if (!orgId) return;
    const res = await fetch(`/api/orgs/${orgId}/skills`);
    if (res.ok) setSkills(await res.json());
  }, [orgId]);

  useEffect(() => {
    fetchSkills();
  }, [fetchSkills]);

  const handleCreate = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!orgId) return;
    setCreating(true);
    const formData = Object.fromEntries(new FormData(e.currentTarget));

    const res = await fetch(`/api/orgs/${orgId}/skills`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: formData.name,
        slug: formData.slug,
        content: formData.content,
      }),
    });

    if (res.ok) {
      setOpen(false);
      await fetchSkills();
    }
    setCreating(false);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-balance">
            Skills
          </h2>
          <p className="mt-1 text-sm text-muted-foreground text-pretty">
            Runtime knowledge agents can reference during execution.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>New Skill</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Skill</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleCreate} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  name="name"
                  placeholder="React Best Practices"
                  required
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="slug">Slug</Label>
                <Input
                  id="slug"
                  name="slug"
                  placeholder="react-best-practices"
                  required
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="content">Content</Label>
                <Textarea
                  id="content"
                  name="content"
                  placeholder="Skill content in markdown..."
                  rows={6}
                  required
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
                  {creating ? "Creating..." : "Create Skill"}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {skills.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16">
          <p className="text-sm text-muted-foreground text-pretty">
            No skills yet. Add skills to give agents domain knowledge.
          </p>
        </div>
      ) : (
        <div className="space-y-px rounded-lg border border-border/50 overflow-hidden">
          {skills.map((skill) => (
            <div
              key={skill.id}
              className="flex items-center justify-between gap-4 p-4"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium truncate">{skill.name}</p>
                  <span className="text-xs text-muted-foreground font-mono shrink-0">
                    {skill.slug}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground truncate">
                  {skill.content.slice(0, 100)}
                  {skill.content.length > 100 ? "..." : ""}
                </p>
              </div>
              <span className="text-xs text-muted-foreground tabular-nums shrink-0">
                {new Date(skill.createdAt).toLocaleDateString()}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
