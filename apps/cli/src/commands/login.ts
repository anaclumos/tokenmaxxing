import { defineCommand } from "citty";
import pc from "picocolors";

export const login = defineCommand({
  meta: { name: "login", description: "Authenticate with tokenmaxx.ing" },
  async run() {
    // TODO: implement auth flow (#24)
    console.log(pc.dim("Login not yet implemented."));
  },
});
