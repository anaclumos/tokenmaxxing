#!/usr/bin/env node

const args = process.argv.slice(2);
const command = args[0];

function printHelp() {
  console.log(`
  tokenmaxxing - CLI

  Usage:
    tokenmaxxing <command>

  Commands:
    help      Show this help message
    version   Show version

  Options:
    --help, -h     Show help
    --version, -v  Show version
`);
}

function printVersion() {
  console.log("tokenmaxxing v0.1.0");
}

switch (command) {
  case "version":
  case "--version":
  case "-v":
    printVersion();
    break;
  case "help":
  case "--help":
  case "-h":
  case undefined:
  default:
    printHelp();
    break;
}
