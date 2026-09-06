import { readFileSync } from "node:fs";
import { z } from "zod";
import { errnoCode } from "./errors.ts";

export function parseJson<S extends z.ZodType>(schema: S, text: string, source: string): z.output<S> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`${source} is corrupt (unparsable JSON) - fix or remove it`, { cause: e });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new Error(`${source} does not match its schema - fix or remove it: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export function tryParseJson<S extends z.ZodType>(schema: S, text: string): z.output<S> | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if (errnoCode(e) === "ENOENT") return null;
    throw e;
  }
}

export function readJson<S extends z.ZodType>(path: string, schema: S): z.output<S> | null {
  const raw = readTextOrNull(path);
  return raw == null ? null : parseJson(schema, raw, path);
}

export function tryReadJson<S extends z.ZodType>(path: string, schema: S): z.output<S> | null {
  const raw = readTextOrNull(path);
  return raw == null ? null : tryParseJson(schema, raw);
}
