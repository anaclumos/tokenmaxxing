import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { childEnv, type Homes, type StubHost } from "./edge-telemetry-fixtures.ts";

export type SentEvent = StubHost["requests"][number]["batch"][number];

export type PersonFault = { event: string; faults: string[] };

const TelemetryJson = z.object({ installId: z.string().min(1) });

const PERSON_OPERATIONS = ["$set", "$set_once", "$unset"];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hermeticEnv(homes: Homes, hostUrl: string): Record<string, string> {
  return childEnv(homes, hostUrl, {
    CLAUDE_CONFIG_DIR: undefined,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: undefined,
    CODEX_HOME: undefined,
    GROK_HOME: undefined,
    KIMI_CODE_HOME: undefined,
  });
}

export function installIdOf(homes: Homes): string {
  return TelemetryJson.parse(JSON.parse(readFileSync(join(homes.state, "telemetry.json"), "utf8"))).installId;
}

export function sentEvents(host: StubHost, fromRequest = 0): SentEvent[] {
  return host.requests.slice(fromRequest).flatMap((request) => request.batch);
}

export function eventNames(events: SentEvent[]): string[] {
  return events.map((event) => event.event).sort();
}

export function distinctIds(events: SentEvent[]): string[] {
  return [...new Set(events.map((event) => event.distinct_id))];
}

function personProperties(holder: Record<string, unknown>): string[] {
  return PERSON_OPERATIONS.flatMap((operation) => {
    const value = holder[operation];
    if (value === undefined) return [];
    if (Array.isArray(value)) return value.map((name) => `${operation} ${String(name)}`);
    if (isRecord(value)) return Object.keys(value).map((name) => `${operation} ${name}`);
    return [`${operation} ${String(value)}`];
  });
}

export function personFaults(events: SentEvent[], installId: string): PersonFault[] {
  return events.flatMap((event) => {
    const faults = [
      ...(event.distinct_id === installId ? [] : [`distinct_id ${event.distinct_id}`]),
      ...("$process_person_profile" in event.properties
        ? [`$process_person_profile ${String(event.properties.$process_person_profile)}`]
        : []),
      ...personProperties(event),
      ...personProperties(event.properties),
    ];
    return faults.length === 0 ? [] : [{ event: event.event, faults }];
  });
}

function fieldHolder(record: Record<string, unknown>): Record<string, unknown> {
  if ("pool" in record || "flags" in record) return record;
  const nested = Object.values(record).filter(isRecord);
  const holder = nested.find((value) => "pool" in value || "flags" in value) ?? (nested.length === 1 ? nested[0] : undefined);
  if (holder === undefined) throw new Error(`no field holder in the spooled event ${JSON.stringify(record)}`);
  return holder;
}

function renewIds(holder: Record<string, unknown>, keep: string): void {
  for (const [key, value] of Object.entries(holder)) {
    if (typeof value !== "string" || value === keep || !UUID.test(value)) continue;
    holder[key] = value.charAt(14) === "7" ? Bun.randomUUIDv7() : crypto.randomUUID();
  }
}

export function spooledLike(
  template: Record<string, unknown>,
  event: string,
  fields: Record<string, unknown>,
  installId: string,
): Record<string, unknown> {
  const copy = structuredClone(template);
  copy.event = event;
  const holder = fieldHolder(copy);
  renewIds(copy, installId);
  if (holder !== copy) renewIds(holder, installId);
  Object.assign(holder, fields);
  return copy;
}

export function writeSpool(homes: Homes, events: Array<Record<string, unknown>>): void {
  writeFileSync(join(homes.state, "telemetry.jsonl"), events.map((event) => `${JSON.stringify(event)}\n`).join(""));
}
