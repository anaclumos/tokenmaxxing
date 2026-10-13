import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { museAuthJsonFor, musePaths, musePool, museStoreDirFor } from "./paths.ts";
import type { SampleReport } from "./provider.ts";
import { readJsonFile, type Harvest } from "./state.ts";
import { statusOnlyProvider, type AuthEntry } from "./statusonly.ts";
import { ErrnoSchema, type Account } from "./types.ts";
import { c } from "../cli/render.ts";

const MuseProviderSchema = z.looseObject({
  access_token: z.string().optional(),
  api_key: z.string().optional(),
  user_email: z.string().nullish(),
});

const MuseAuthSchema = z.looseObject({
  providers: z.record(z.string(), z.unknown()),
});
type MuseAuth = z.infer<typeof MuseAuthSchema>;

function readFile(path: string): MuseAuth | null {
  try {
    return readJsonFile(path, MuseAuthSchema);
  } catch (e) {
    if (ErrnoSchema.safeParse(e).data?.code === "ENOENT") return null;
    throw e;
  }
}

function readAuth(path: string): AuthEntry[] {
  const file = readFile(path);
  if (file == null) return [];
  const out: AuthEntry[] = [];
  for (const [key, value] of Object.entries(file.providers)) {
    const parsed = MuseProviderSchema.safeParse(value);
    if (!parsed.success) continue;
    const email = parsed.data.user_email?.trim().toLowerCase() ?? "";
    const id = email === "" ? "" : new Bun.CryptoHasher("sha256").update(email).digest("hex");
    const harvest: Harvest | null =
      id === ""
        ? null
        : {
            id,
            email,
            tier: null,
            sample: null,
            park: async () => {
              writeFileAtomic(museAuthJsonFor(id), JSON.stringify({ ...file, providers: { [key]: value } }, null, 2), 0o600);
            },
          };
    out.push({ id, usable: (parsed.data.access_token ?? "") !== "" || (parsed.data.api_key ?? "") !== "", harvest });
  }
  return out;
}

async function samplePool(accounts: Account[]): Promise<Map<string, SampleReport>> {
  return new Map(accounts.map((a) => [a.id, { ok: false, reason: "Muse Code exposes no read-only quota endpoint" }]));
}

export const muse = statusOnlyProvider({
  name: "muse",
  flag: " --muse",
  pool: musePool,
  binName: "muse",
  binKey: "museBin",
  storeDirFor: museStoreDirFor,
  authJsonFor: museAuthJsonFor,
  onboardDir: musePaths.onboardDir,
  homeEnv: "XDG_CONFIG_HOME",
  loginArgs: ["login"],
  onboardAuthRel: "muse/auth.json",
  liveAuthPath: () => musePaths.authJson,
  readAuth,
  liveId: () => null,
  presence: () => new Map(),
  versionOk: (out) => out.toLowerCase().includes("muse code"),
  importIntro: "Opening an isolated Muse Code login for your first pooled account - the login you already have stays as it is.",
  foundLive: (count) => `found ${count} Muse Code login(s) in ${musePaths.authJson} - pooling the first; use \`tokenmaxxing add --muse\` for the rest.`,
  installNotice: "muse pool is status-only: no supervisor or hooks installed. Use `tokenmaxxing status` to view pooled Muse Code accounts.",
  loginStep: () => `Approve the code in the browser that ${c.bold("muse login")} opens.`,
  samplePool,
});
