"use client";

import { createRoutineAction } from "@/lib/board/actions";
import { SubmitButton } from "@/components/submit-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type NewRoutineDialogProps = {
  agents: {
    id: string;
    title: string;
  }[];
};

export function NewRoutineDialog({ agents }: NewRoutineDialogProps) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button>New Routine</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Routine</DialogTitle>
          <DialogDescription>
            Schedule recurring work for one of your agents.
          </DialogDescription>
        </DialogHeader>

        <form action={createRoutineAction} className="space-y-4">
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
            <Label htmlFor="agentId">Agent</Label>
            <select
              id="agentId"
              name="agentId"
              defaultValue=""
              required
              className="flex h-10 w-full rounded-lg border border-input bg-transparent px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="" disabled>
                Select an agent...
              </option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.title}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cron">Cron Expression</Label>
            <Input id="cron" name="cron" placeholder="0 9 * * 1-5" />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <SubmitButton pendingText="Creating...">
              Create Routine
            </SubmitButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
