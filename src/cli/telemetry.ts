import { setTelemetry, TELEMETRY_DOCS, telemetryState, type Telemetry } from "../lib/telemetry.ts";
import { c, emitError } from "./render.ts";

const CHOICES = new Map([["on", true], ["off", false]]);

const STATE_TEXT: Record<Telemetry, string> = {
  on: c.green("on"),
  off: c.yellow("off"),
  env: c.yellow("off (DO_NOT_TRACK or TOKENMAXXING_TELEMETRY turned it off, and config.json keeps it off)"),
  ci: c.yellow("off while CI is set"),
};

export async function cmdTelemetry(args: string[]): Promise<number> {
  const [choice, extra] = args;
  const on = choice == null ? undefined : CHOICES.get(choice);
  if (extra != null || (choice != null && on == null)) {
    emitError({ message: `usage: tokenmaxxing telemetry [on|off], got: ${args.join(" ")}` });
    return 2;
  }
  if (on != null) await setTelemetry(on);
  console.log(`telemetry is ${STATE_TEXT[telemetryState()]}`);
  console.log(c.dim(`what it sends: ${TELEMETRY_DOCS}`));
  return 0;
}
