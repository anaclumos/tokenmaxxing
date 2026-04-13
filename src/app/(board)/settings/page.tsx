export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight text-balance">
          Settings
        </h2>
        <p className="mt-1 text-sm text-muted-foreground text-pretty">
          Organization configuration.
        </p>
      </div>

      <div>
        <h3 className="text-sm font-medium">General</h3>
        <p className="mt-2 text-sm text-muted-foreground text-pretty">
          Organization settings managed through Clerk.
        </p>
      </div>
    </div>
  );
}
