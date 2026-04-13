"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useOrgId } from "@/hooks/use-org-id";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";

type Issue = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assigneeId: string | null;
  createdAt: string;
};

type Comment = {
  id: string;
  authorType: string;
  authorId: string;
  body: string;
  createdAt: string;
};

const STATUS_COLORS: Record<string, "default" | "secondary" | "outline"> = {
  backlog: "outline",
  todo: "outline",
  in_progress: "secondary",
  in_review: "secondary",
  done: "default",
};

const STATUSES = ["backlog", "todo", "in_progress", "in_review", "done", "cancelled"];

export default function IssueDetailPage() {
  const orgId = useOrgId();
  const { issueId } = useParams<{ issueId: string }>();
  const [issue, setIssue] = useState<Issue | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [commentBody, setCommentBody] = useState("");
  const [posting, setPosting] = useState(false);

  const fetchIssue = useCallback(async () => {
    if (!orgId) return;
    const res = await fetch(`/api/orgs/${orgId}/issues/${issueId}`);
    if (res.ok) setIssue(await res.json());
  }, [orgId, issueId]);

  const fetchComments = useCallback(async () => {
    if (!orgId) return;
    const res = await fetch(
      `/api/orgs/${orgId}/issues/${issueId}/comments`,
    );
    if (res.ok) setComments(await res.json());
  }, [orgId, issueId]);

  useEffect(() => {
    fetchIssue();
    fetchComments();
  }, [fetchIssue, fetchComments]);

  const handleStatusChange = async (newStatus: string) => {
    if (!orgId || !issue) return;
    const res = await fetch(`/api/orgs/${orgId}/issues/${issueId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: newStatus }),
    });
    if (res.ok) setIssue(await res.json());
  };

  const handleAddComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!orgId || !commentBody.trim()) return;
    setPosting(true);
    const res = await fetch(
      `/api/orgs/${orgId}/issues/${issueId}/comments`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: commentBody }),
      },
    );
    if (res.ok) {
      setCommentBody("");
      await fetchComments();
    }
    setPosting(false);
  };

  if (!issue) {
    return (
      <div className="py-16 text-center text-sm text-muted-foreground">
        Loading...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h2 className="text-2xl font-semibold tracking-tight text-balance">
          {issue.title}
        </h2>
        <Badge variant={STATUS_COLORS[issue.status] ?? "outline"}>
          {issue.status.replace("_", " ")}
        </Badge>
      </div>

      <div className="grid gap-8 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          {issue.description && (
            <div>
              <h3 className="text-sm font-medium">Description</h3>
              <p className="mt-2 text-sm text-muted-foreground whitespace-pre-wrap">
                {issue.description}
              </p>
            </div>
          )}

          <div>
            <h3 className="text-sm font-medium">
              Comments ({comments.length})
            </h3>
            {comments.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground text-pretty">
                No comments yet.
              </p>
            ) : (
              <div className="mt-3 space-y-px rounded-lg border border-border/50 overflow-hidden">
                {comments.map((comment) => (
                  <div key={comment.id} className="p-4 space-y-1">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs">
                        {comment.authorType}
                      </Badge>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {new Date(comment.createdAt).toLocaleString()}
                      </span>
                    </div>
                    <p className="text-sm whitespace-pre-wrap">
                      {comment.body}
                    </p>
                  </div>
                ))}
              </div>
            )}

            <form onSubmit={handleAddComment} className="mt-4 space-y-3">
              <Textarea
                placeholder="Write a comment..."
                value={commentBody}
                onChange={(e) => setCommentBody(e.target.value)}
                rows={3}
              />
              <div className="flex justify-end">
                <Button type="submit" disabled={posting || !commentBody.trim()}>
                  {posting ? "Posting..." : "Add Comment"}
                </Button>
              </div>
            </form>
          </div>
        </div>

        <div>
          <h3 className="text-sm font-medium">Properties</h3>
          <dl className="mt-3 space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">Status</dt>
              <dd>
                <Select value={issue.status} onValueChange={handleStatusChange}>
                  <SelectTrigger size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s.replace("_", " ")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </dd>
            </div>
            <Separator />
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Priority</dt>
              <dd>{issue.priority}</dd>
            </div>
            <Separator />
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Assignee</dt>
              <dd className={issue.assigneeId ? "" : "text-muted-foreground"}>
                {issue.assigneeId
                  ? issue.assigneeId.slice(0, 8)
                  : "Unassigned"}
              </dd>
            </div>
            <Separator />
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Created</dt>
              <dd className="text-xs tabular-nums">
                {new Date(issue.createdAt).toLocaleDateString()}
              </dd>
            </div>
          </dl>
        </div>
      </div>
    </div>
  );
}
