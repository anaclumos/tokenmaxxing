#!/usr/bin/env bun

import { errorMessage } from "./lib/errors.ts";
import { emitError } from "./cli/render.ts";

try {
  const { dispatch } = await import("./cli/dispatch.ts");
  process.exit(await dispatch());
} catch (e) {
  emitError({ json: process.argv.includes("--json"), message: errorMessage(e) });
  process.exit(1);
}
