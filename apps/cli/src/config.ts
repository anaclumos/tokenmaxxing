import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { z } from "zod"

const DEFAULT_SERVER_URL = "https://tokenmaxx.ing"
const CONFIG_DIR = join(homedir(), ".config", "tokenmaxxing")
const CONFIG_FILE = join(CONFIG_DIR, "config.json")

const Config = z.object({
  token: z.string().min(1).optional(),
  server: z.url().optional(),
})

type Config = z.infer<typeof Config>

function readConfig(): Config {
  if (!existsSync(CONFIG_FILE)) {
    return Config.parse({})
  }

  return Config.parse(JSON.parse(readFileSync(CONFIG_FILE, "utf-8")))
}

function writeConfig(config: Config) {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))
}

export function getApiToken(): string | null {
  return readConfig().token ?? null
}

export function getServerUrl(): string {
  return readConfig().server ?? DEFAULT_SERVER_URL
}

export function saveApiToken(token: string) {
  writeConfig({ ...readConfig(), token })
}
