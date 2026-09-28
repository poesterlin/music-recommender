#!/usr/bin/env bun
/**
 * First run for a new install.
 *
 * Nothing to configure and nothing to clone: this downloads compose.yaml and
 * .env.example, writes a .env with fresh secrets, then starts the published
 * images. Run it from the folder you want the install to live in.
 *
 *   curl -fsSL https://raw.githubusercontent.com/poesterlin/music-recommender/main/setup.ts | bun run -
 *
 * Every prompt is optional. Pressing Enter accepts the default and the app
 * starts with a local database, so there is always something to open.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

/**
 * GitHub repository the compose files are downloaded from. Must track the
 * repository actually hosting this script; override with SOLE_REPO after a
 * rename or when running from a fork.
 */
const REPO = process.env.SOLE_REPO ?? "poesterlin/music-recommender";
const RAW = `https://raw.githubusercontent.com/${REPO}/main`;
const EXAMPLE_URL = `${RAW}/.env.example`;
const COMPOSE_FILE = "compose.yaml";
const STACK_FILE = "stack.yaml";
const ENV_FILE = ".env";

function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

async function has(command: string): Promise<boolean> {
  const probe = Bun.spawn(["sh", "-c", `command -v ${command}`], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await probe.exited) === 0;
}

if (!(await has("docker"))) {
  fail("Docker is required. Install it from https://docs.docker.com/get-docker/ and run this again.");
}
const composeCheck = Bun.spawnSync(["docker", "compose", "version"], {
  stdout: "ignore",
  stderr: "ignore",
});
if (composeCheck.exitCode !== 0) {
  fail("Docker Compose v2 is required. Update Docker so `docker compose version` works.");
}

const readline = createInterface({ input: process.stdin, output: process.stdout });
const ask = async (question: string, fallback: string): Promise<string> => {
  const answer = (await readline.question(`${question} [${fallback}]: `)).trim();
  return answer || fallback;
};

console.log("Sole setup. Press Enter to accept each default.");

let library = "";
if (existsSync(".env") && !process.argv.includes("--force")) {
  readline.close();
  const reuse = existsSync(COMPOSE_FILE) ? " Reusing the settings already here." : "";
  console.log(`\nAn .env already exists, so this is not a first run.${reuse}\n`);
  console.log("To start or update:\n\n  docker compose up -d\n");
  console.log("To change the library path or service details, edit .env and rerun `docker compose up -d`.");
  process.exit(0);
}

const defaultLibrary = `${process.env.HOME ?? "~"}/Music`;
library = await ask("Folder that contains your music (read-only)", defaultLibrary);
if (!existsSync(library)) {
  console.log(`\nNote: ${library} does not exist yet. The app will start, but cannot read music until it does.`);
}
readline.close();

if (!existsSync(STACK_FILE)) {
  console.log(`\nDownloading ${STACK_FILE} and ${COMPOSE_FILE} ...`);
  for (const name of [STACK_FILE, COMPOSE_FILE]) {
    const response = await fetch(`${RAW}/${name}`);
    if (!response.ok) fail(`Could not download ${name} (HTTP ${response.status}).`);
    writeFileSync(name, await response.text());
  }
}

let example = "";
const exampleResponse = await fetch(EXAMPLE_URL);
if (exampleResponse.ok) example = await exampleResponse.text();
else if (existsSync(".env.example")) example = readFileSync(".env.example", "utf8");

const password = randomBytes(24).toString("hex");
const workerToken = randomBytes(24).toString("hex");
const adminPassword = randomBytes(12).toString("base64url");

const settings: Record<string, string> = {
  DOMAIN: "localhost",
  ORIGIN: "http://127.0.0.1:4932",
  MUSIC_LIBRARY_PATH: library,
  POSTGRES_PASSWORD: password,
  DATABASE_URL: `postgres://sole:${password}@127.0.0.1:5432/sole`,
  DATABASE_INTERNAL_URL: `postgres://sole:${password}@postgres:5432/sole`,
  WORKER_TOKEN: workerToken,
};

// .env.example ships placeholder hosts so the file documents every setting.
// A fresh install must not point at them, so the ones an installer has not
// filled in yet are blanked and proven-empty at the point of use.
const placeholders = [
  "MUSIC_HOST",
  "MA_TOKEN",
  "HA_HOST",
  "TOKEN",
  "CONFIG_ID",
  "WEBHOOK_URL",
  "PLAYBACK_API_KEY",
  "HA_PLAYER_ENTITY",
  "LIDARR_API_KEY",
];

// Every compose command below names its files explicitly. Without that, a
// checkout that happens to sit in the same folder would silently swap in the
// build-from-source stack.
const composeArgs = ["docker", "compose", "-f", STACK_FILE, "--env-file", ENV_FILE];

// Keep every documented setting from .env.example, replacing the ones this run
// knows better and blanking the example placeholders.
const blanked = new Set(placeholders);
const known = new Set<string>();
let contents = example
  .split("\n")
  .map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=/);
    if (!match) return line;
    const key = match[1];
    known.add(key);
    if (key in settings) return `${key}=${settings[key]}`;
    if (blanked.has(key)) return `${key}=`;
    return line;
  })
  .join("\n");

for (const [key, value] of Object.entries(settings)) {
  if (!known.has(key)) contents += `${contents.endsWith("\n") ? "" : "\n"}${key}=${value}\n`;
}

// WEB_PORT and POSTGRES_PORT belong to the stack, not the example file, so the
// port shown in the final message and the ORIGIN above stay consistent.
if (!contents.includes("WEB_PORT=")) contents += "WEB_PORT=4932\n";
if (!contents.includes("POSTGRES_PORT=")) contents += "POSTGRES_PORT=5432\n";

writeFileSync(ENV_FILE, contents, { mode: 0o600 });
console.log(`Wrote ${ENV_FILE} with a generated database password.`);
console.log(`Your music folder is mounted read-only at /music.`);

console.log("\nStarting PostgreSQL and the app ...");
const up = Bun.spawn([...composeArgs, "up", "-d", "--wait"], {
  stdout: "inherit",
  stderr: "inherit",
});
if ((await up.exited) !== 0) {
  fail(`Startup failed. Check the output above, then rerun \`docker compose up -d\`.`);
}

console.log("\nWaiting for the database, then applying the schema ...");
const migrate = Bun.spawn(
  [
    ...composeArgs,
    "run",
    "--rm",
    "--entrypoint",
    "sh",
    "web",
    "-c",
    "bun scripts/ensure-pgvector.ts && bunx drizzle-kit migrate",
  ],
  { stdout: "inherit", stderr: "inherit" },
);
if ((await migrate.exited) !== 0) {
  console.log("\nThe schema step failed. Check the output above and rerun:");
  console.log("  docker compose run --rm --entrypoint sh web -c 'bun scripts/ensure-pgvector.ts && bunx drizzle-kit migrate'");
}

const createUser = [
  ...composeArgs,
  "run",
  "--rm",
  "--entrypoint",
  "bun",
  "web",
  "web/scripts/create-user.ts",
  "--username",
  "admin",
  "--password",
  adminPassword,
];

console.log("\nCreating the admin account ...");
const seed = Bun.spawn(createUser, { stdout: "inherit", stderr: "inherit" });
await seed.exited;

const port = 4932;
console.log(`
Ready.

  Open      http://127.0.0.1:${port}/login
  Username  admin
  Password  ${adminPassword}

  Music     ${library}
  Settings  .env  (nothing there is secret from you; keep it out of git)

Add Music Assistant and Home Assistant details to .env, then run:
  docker compose up -d

Change the music folder or ports? Edit .env and run \`docker compose up -d\` again.
`);
