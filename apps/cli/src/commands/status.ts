import { defineCommand } from "citty";
import pc from "picocolors";

export const status = defineCommand({
  meta: { name: "status", description: "Show your rank and stats" },
  async run() {
    // TODO: implement status display (#26)
    console.log(pc.dim("Status not yet implemented."));
  },
});
