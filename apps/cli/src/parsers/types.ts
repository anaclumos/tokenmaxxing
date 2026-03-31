import type { SupportedClient, UsageRecord } from "@tokenmaxxing/shared/types";

// Every platform parser implements this interface
export interface ClientParser {
  client: SupportedClient;
  // Returns true if this client's data exists on this machine
  detect(): Promise<boolean>;
  // Yields parsed usage records
  parse(): AsyncGenerator<UsageRecord>;
}
