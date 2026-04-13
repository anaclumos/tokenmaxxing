export default async function globalTeardown() {
  // Keep Postgres running for faster re-runs during development.
  // Run `docker compose down -v` manually to clean up.
  console.log("[teardown] Postgres left running for fast re-runs.");
  console.log("[teardown] Run `bun run db:down` to stop.");
}
