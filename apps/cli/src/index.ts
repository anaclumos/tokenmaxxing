#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import { submit } from "./commands/submit";
import { login } from "./commands/login";
import { status } from "./commands/status";

const main = defineCommand({
  meta: { name: "tokenmaxxing", version: "0.1.0", description: "Compete on token consumption" },
  subCommands: { submit, login, status },
});

runMain(main);
