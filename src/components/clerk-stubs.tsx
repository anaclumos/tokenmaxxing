"use client";

import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

export function MockOrgSwitcher() {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border/50 px-3 py-1.5">
      <span className="text-sm">Test Organization</span>
      <Badge variant="outline" className="text-xs">
        dev
      </Badge>
    </div>
  );
}

export function MockUserButton() {
  return (
    <Avatar className="size-8">
      <AvatarFallback className="text-xs">TE</AvatarFallback>
    </Avatar>
  );
}

export function MockOrgProfile() {
  return (
    <div className="rounded-md border border-border/50 p-4 text-sm text-muted-foreground">
      Member management is available when Clerk auth is enabled.
    </div>
  );
}
