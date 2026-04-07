"use client";

import { Button } from "@tokenmaxxing/ui/components/button";
import ky from "ky";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function BudgetThresholdDeleteButton({
  budgetId,
  orgId,
}: {
  budgetId: string;
  orgId: string;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function remove() {
    setLoading(true);
    await ky.delete(`/api/orgs/${orgId}/budgets/${budgetId}`);
    setLoading(false);
    router.refresh();
  }

  return (
    <Button type="button" variant="destructive" size="sm" onClick={remove} disabled={loading}>
      {loading ? "Removing..." : "Remove"}
    </Button>
  );
}
