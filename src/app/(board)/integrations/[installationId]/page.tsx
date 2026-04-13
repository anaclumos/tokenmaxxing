export default async function IntegrationDetailPage({
  params,
}: {
  params: Promise<{ installationId: string }>;
}) {
  const { installationId } = await params;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight text-balance">
          Integration
        </h2>
        <p className="mt-1 text-sm text-muted-foreground text-pretty">
          Configure credentials and agent assignments.
        </p>
      </div>

      <div>
        <h3 className="text-sm font-medium">Credentials</h3>
        <p className="mt-2 text-sm text-muted-foreground text-pretty">
          Installation {installationId} credentials and configuration.
        </p>
      </div>
    </div>
  );
}
