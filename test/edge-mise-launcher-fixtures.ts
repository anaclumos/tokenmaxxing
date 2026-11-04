import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");

export type Home = { env: Record<string, string>; tm: string; launcher: string };
export type FakeClaude = { bin: string; session: string };

export function scratch(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "tokenmaxxing-edge-mise-")));
}

export function tokenmaxxingHome(root: string): Home {
  const home = join(root, "home");
  const tm = join(home, ".config", "tokenmaxxing");
  mkdirSync(tm, { recursive: true });
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith("TOKENMAXXING_") || ["HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"].includes(key)) continue;
    env[key] = value;
  }
  Object.assign(env, {
    HOME: home,
    TOKENMAXXING_HOME: tm,
    TOKENMAXXING_CLAUDE_SETTINGS: join(home, ".claude", "settings.json"),
    TOKENMAXXING_SYSTEMD_USER_DIR: join(home, ".config", "systemd", "user"),
    TOKENMAXXING_LAUNCHD_DIR: join(home, "Library", "LaunchAgents"),
    TOKENMAXXING_SKIP_TIMER: "1",
    TOKENMAXXING_SKIP_HUB: "1",
    TOKENMAXXING_SKIP_SHELL_RC: "1",
  });
  return { env, tm, launcher: join(tm, "bin", "tokenmaxxing") };
}

function entryScript(version: string): string {
  return `const verb = process.argv[2];
if (verb === "init") (await import(${JSON.stringify(join(SRC, "lib", "install.ts"))})).installSupervisor();
else if (verb === "doctor") await (await import(${JSON.stringify(join(SRC, "cli", "doctor.ts"))})).cmdDoctor();
else if (verb === "open-claude") {
  const session = Bun.spawn(process.argv.slice(3), { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  console.log(session.pid);
  await session.exited;
} else console.log(JSON.stringify({ version: ${JSON.stringify(version)}, bun: process.execPath, args: process.argv.slice(2) }));
`;
}

export function miseTool(installs: string, name: string, short: string, full: string): string {
  const dir = join(installs, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".mise.backend.toml"), `short = ${JSON.stringify(short)}\nfull = ${JSON.stringify(full)}\nexplicit_backend = true\n`);
  return dir;
}

export function npmPackage(dir: string, version: string): string {
  const src = join(dir, "node_modules", "tokenmaxxing", "src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "main.ts"), entryScript(version));
  mkdirSync(join(dir, "bin"), { recursive: true });
  symlinkSync("../node_modules/tokenmaxxing/src/main.ts", join(dir, "bin", "tokenmaxxing"));
  return join(dir, "bin", "tokenmaxxing");
}

export function bunGlobalPackage(root: string, version: string): { link: string; main: string } {
  const src = join(root, ".bun", "install", "global", "node_modules", "tokenmaxxing", "src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "main.ts"), entryScript(version));
  const link = join(root, ".bun", "bin", "tokenmaxxing");
  if (!existsSync(link)) {
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync("../install/global/node_modules/tokenmaxxing/src/main.ts", link);
  }
  return { link, main: join(src, "main.ts") };
}

export function placeBun(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, name);
  try {
    linkSync(realpathSync(process.execPath), target);
  } catch (e) {
    if (!(e instanceof Error && "code" in e && (e.code === "EXDEV" || e.code === "EPERM"))) throw e;
    copyFileSync(realpathSync(process.execPath), target);
    chmodSync(target, 0o755);
  }
  return target;
}

export function pointAlias(tool: string, alias: string, version: string): void {
  rmSync(join(tool, alias), { force: true });
  symlinkSync(`./${version}`, join(tool, alias));
}

export function prune(root: string, path: string): void {
  const grave = join(root, "pruned");
  mkdirSync(grave, { recursive: true });
  renameSync(path, join(grave, `${basename(dirname(path))}-${basename(path)}`));
}

export function run(argv: string[], env: Record<string, string>) {
  const p = Bun.spawnSync(argv, { env, stdout: "pipe", stderr: "pipe", timeout: 20_000 });
  return { exitCode: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function launcherReport(home: Home, launcher: string, args: string[]) {
  const result = run([launcher, ...args], home.env);
  return {
    exitCode: result.exitCode,
    report: parsed(result.stdout),
    stderr: result.stderr,
    launcher: existsSync(home.launcher) ? readFileSync(home.launcher, "utf8") : null,
  };
}

export function fakeClaude(root: string, home: Home): FakeClaude {
  const bin = placeBun(join(root, "claude-code"), "claude");
  const session = join(root, "session.js");
  writeFileSync(session, "setTimeout(() => {}, 120_000);\n");
  writeFileSync(join(home.tm, "config.json"), JSON.stringify({ claudeBin: bin }));
  return { bin, session };
}

function end(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (e) {
    if (!(e instanceof Error && "code" in e && e.code === "ESRCH")) throw e;
  }
}

export async function openThroughLauncher(home: Home, claude: FakeClaude): Promise<{ pid: number; close: () => void }> {
  const opener = Bun.spawn([home.launcher, "open-claude", claude.bin, claude.session], { env: home.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let text = "";
  for await (const chunk of opener.stdout) {
    text += Buffer.from(chunk).toString("utf8");
    if (text.includes("\n")) break;
  }
  const pid = Number.parseInt(text, 10);
  if (!(pid > 0)) throw new Error(`the launcher opened no claude session: ${text}${await new Response(opener.stderr).text()}`);
  return {
    pid,
    close: () => {
      end(pid);
      end(opener.pid);
    },
  };
}

export function openStray(claude: FakeClaude): { pid: number; close: () => void } {
  const stray = Bun.spawn([claude.bin, claude.session], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  return { pid: stray.pid, close: () => end(stray.pid) };
}

export function listed(doctorStdout: string, pid: number): boolean {
  return doctorStdout.includes(`outside the supervisor (pid ${pid})`);
}
