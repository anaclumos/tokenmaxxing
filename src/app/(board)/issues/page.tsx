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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useOrgId } from "@/hooks/use-org-id";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

type Issue = {
  id: string;
  title: string;
  status: string;
  priority: string;
  assigneeId: string | null;
  createdAt: string;
};

const STATUS_COLORS: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  backlog: "outline",
  todo: "outline",
  in_progress: "secondary",
  in_review: "secondary",
  done: "default",
  cancelled: "outline",
};

export default function IssuesPage() {
  const orgId = useOrgId();
  const [issues, setIssues] = useState<Issue[]>([]);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [tab, setTab] = useState("all");
  const [status, setStatus] = useState("backlog");
  const [priority, setPriority] = useState("medium");

  const fetchIssues = useCallback(async () => {
    if (!orgId) return;
    const params = tab !== "all" ? `?status=${tab}` : "";
    const res = await fetch(`/api/orgs/${orgId}/issues${params}`);
    if (res.ok) setIssues(await res.json());
  }, [orgId, tab]);

  useEffect(() => {
    fetchIssues();
  }, [fetchIssues]);

  const handleCreate = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!orgId) return;
    setCreating(true);
    const formData = Object.fromEntries(new FormData(e.currentTarget));

    const res = await fetch(`/api/orgs/${orgId}/issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...formData, status, priority }),
    });

    if (res.ok) {
      setOpen(false);
      setStatus("backlog");
      setPriority("medium");
      await fetchIssues();
    }
    setCreating(false);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-balance">
            Issues
          </h2>
          <p className="mt-1 text-sm text-muted-foreground text-pretty">
            Tasks for your agents to work on.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>New Issue</Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Create Issue</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleCreate} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="title">Title</Label>
                <Input
                  id="title"
                  name="title"
                  placeholder="Build the landing page"
                  required
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  name="description"
                  placeholder="Describe the task..."
                  rows={3}
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="status">Status</Label>
                  <Select value={status} onValueChange={setStatus}>
                    <SelectTrigger id="status">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="backlog">Backlog</SelectItem>
                      <SelectItem value="todo">Todo</SelectItem>
                      <SelectItem value="in_progress">In Progress</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="priority">Priority</Label>
                  <Select value={priority} onValueChange={setPriority}>
                    <SelectTrigger id="priority">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="urgent">Urgent</SelectItem>
                      <SelectItem value="high">High</SelectItem>
                      <SelectItem value="medium">Medium</SelectItem>
                      <SelectItem value="low">Low</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
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
                  {creating ? "Creating..." : "Create Issue"}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="backlog">Backlog</TabsTrigger>
          <TabsTrigger value="in_progress">In Progress</TabsTrigger>
          <TabsTrigger value="in_review">In Review</TabsTrigger>
          <TabsTrigger value="done">Done</TabsTrigger>
        </TabsList>

        <TabsContent value={tab} className="mt-6">
          {issues.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16">
              <p className="text-sm text-muted-foreground text-pretty">
                {tab === "all"
                  ? "No issues yet. Create your first issue to assign work to an agent."
                  : `No ${tab.replace("_", " ")} issues.`}
              </p>
            </div>
          ) : (
            <div className="space-y-px rounded-lg border border-border/50 overflow-hidden">
              {issues.map((issue) => (
                <Link
                  key={issue.id}
                  href={`/issues/${issue.id}`}
                  className="flex items-center justify-between gap-4 p-4 hover:bg-muted/50 transition-colors"
                >
                  <p className="text-sm font-medium truncate min-w-0">
                    {issue.title}
                  </p>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge
                      variant={STATUS_COLORS[issue.status] ?? "outline"}
                      className="text-xs"
                    >
                      {issue.status.replace("_", " ")}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {issue.priority}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
