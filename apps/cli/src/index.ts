#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";
import { submit } from "./commands/submit";
import { login } from "./commands/login";
import { status } from "./commands/status";
import { stats } from "./commands/stats";
import { pricing } from "./commands/pricing";
import { wrapped } from "./commands/wrapped";

const main = defineCommand({
  meta: { name: "tokenmaxxing", version: "0.1.0", description: "Compete on token consumption" },
  subCommands: { submit, login, status, stats, pricing, wrapped },
});

runMain(main);
