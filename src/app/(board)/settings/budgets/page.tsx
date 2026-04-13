export default function BudgetsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight text-balance">
          Budgets
        </h2>
        <p className="mt-1 text-sm text-muted-foreground text-pretty">
          Set spending limits per agent and organization-wide.
        </p>
      </div>

      <div>
        <h3 className="text-sm font-medium">Organization Budget</h3>
        <p className="mt-2 text-sm text-muted-foreground text-pretty">
          Budget policies will be configurable here. Per-agent monthly limits
          are set on the agent configuration page.
        </p>
      </div>
    </div>
  );
}
