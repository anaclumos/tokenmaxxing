"use client";

import { useState } from "react";
import { createAgentAction } from "@/lib/board/actions";
import { SubmitButton } from "@/components/submit-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export function NewAgentDialog() {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>New Agent</Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Agent</DialogTitle>
          <DialogDescription>
            Add a new AI teammate with a model, role, and budget.
          </DialogDescription>
        </DialogHeader>

        <form action={createAgentAction} className="space-y-4">
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
              <select
                id="provider"
                name="provider"
                defaultValue=""
                required
                className="flex h-10 w-full rounded-lg border border-input bg-transparent px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="" disabled>
                  Select...
                </option>
                <option value="anthropic">Anthropic</option>
                <option value="openai">OpenAI</option>
                <option value="google">Google</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="model">Model</Label>
              <Input
                id="model"
                name="model"
                placeholder="gpt-5.4"
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
            <Label htmlFor="monthlyBudgetCents">Monthly Budget (cents)</Label>
            <Input
              id="monthlyBudgetCents"
              name="monthlyBudgetCents"
              min="0"
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
            <SubmitButton pendingText="Creating...">Create Agent</SubmitButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
