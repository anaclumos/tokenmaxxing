import { paths } from "../lib/paths.ts";
import { loadConfig } from "../lib/state.ts";
import type { Config } from "../lib/types.ts";
import { c, emitError, emitJson } from "./render.ts";

export function cmdConfig(args: string[], json = false): number {
  if (args.length > 0) {
    emitError({ json, message: `unknown config option: ${args[0]} (config takes no options; edit ${paths.configJson} in an editor)` });
    return 2;
  }
  let effective: Config;
  try {
    effective = loadConfig();
  } catch (e) {
    emitError({ json, message: e instanceof Error ? e.message : String(e), extra: { path: paths.configJson } });
    return 1;
  }
  if (json) {
    emitJson({ ok: true, path: paths.configJson, effective });
    return 0;
  }
  console.log(c.dim(`config.json: ${paths.configJson}`));
  console.log(JSON.stringify(effective, null, 2));
  return 0;
}
