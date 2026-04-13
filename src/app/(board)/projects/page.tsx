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

type Project = {
  id: string;
  name: string;
  description: string | null;
  repoUrl: string | null;
  createdAt: string;
};

export default function ProjectsPage() {
  const orgId = useOrgId();
  const [projects, setProjects] = useState<Project[]>([]);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  const fetchProjects = useCallback(async () => {
    if (!orgId) return;
    const res = await fetch(`/api/orgs/${orgId}/projects`);
    if (res.ok) setProjects(await res.json());
  }, [orgId]);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  const handleCreate = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!orgId) return;
    setCreating(true);
    const data = Object.fromEntries(new FormData(e.currentTarget));

    const res = await fetch(`/api/orgs/${orgId}/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });

    if (res.ok) {
      setOpen(false);
      await fetchProjects();
    }
    setCreating(false);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-balance">
            Projects
          </h2>
          <p className="mt-1 text-sm text-muted-foreground text-pretty">
            Repositories and workstreams your agents operate in.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>New Project</Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Create Project</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleCreate} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  name="name"
                  placeholder="my-saas-app"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  name="description"
                  placeholder="What is this project about?"
                  rows={2}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="repoUrl">Repository URL</Label>
                <Input
                  id="repoUrl"
                  name="repoUrl"
                  type="url"
                  placeholder="https://github.com/org/repo"
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
                  {creating ? "Creating..." : "Create Project"}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {projects.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16">
          <p className="text-sm text-muted-foreground text-pretty">
            No projects yet. Connect a repository to get started.
          </p>
        </div>
      ) : (
        <div className="space-y-px rounded-lg border border-border/50 overflow-hidden">
          {projects.map((project) => (
            <div
              key={project.id}
              className="p-4 hover:bg-muted/50 transition-colors"
            >
              <p className="text-sm font-medium">{project.name}</p>
              {project.repoUrl && (
                <p className="mt-0.5 text-xs text-muted-foreground font-mono truncate">
                  {project.repoUrl}
                </p>
              )}
              {project.description && (
                <p className="mt-1 text-xs text-muted-foreground text-pretty line-clamp-2">
                  {project.description}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
