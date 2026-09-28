import { randomBytes } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const envFile = resolve(root, ".env.local");
const musicArg = process.argv.slice(2).find((arg) => !arg.startsWith("-"));

if (!musicArg || process.argv.includes("--help")) {
  console.log(
    "Usage: bun --no-env-file scripts/setup-local.ts /absolute/path/to/music",
  );
  process.exit(process.argv.includes("--help") ? 0 : 1);
}

const musicPath = await realpath(resolve(musicArg));
if (!(await stat(musicPath)).isDirectory() || /[\r\n$]/.test(musicPath)) {
  throw new Error(
    "Choose a music directory without line breaks or $ in its path.",
  );
}

const password = randomBytes(24).toString("hex");
const workerToken = randomBytes(24).toString("hex");
const databaseUrl = `postgres://recommender:${password}@127.0.0.1:55433/recommender`;
const contents = [
  "# Local setup only. Your existing .env is not used.",
  "APP_ENV_FILE=.env.local",
  "SETUP_MODE=local",
  "TRAEFIK_EXTERNAL=false",
  "TRAEFIK_NETWORK=music_recommender_local_proxy",
  "DOMAIN=localhost",
  "WEB_PORT=4933",
  "POSTGRES_PORT=55433",
  "POSTGRES_USER=recommender",
  `POSTGRES_PASSWORD=${password}`,
  "POSTGRES_DB=recommender",
  `DATABASE_URL=${databaseUrl}`,
  `DATABASE_INTERNAL_URL=postgres://recommender:${password}@postgres:5432/recommender`,
  `MUSIC_LIBRARY_PATH=${musicPath}`,
  `WORKER_TOKEN=${workerToken}`,
  "MUSIC_HOST=",
  "MA_TOKEN=",
  "HA_HOST=",
  "TOKEN=",
  "CONFIG_ID=",
  "",
].join("\n");

// Exclusive creation protects an existing local database's credentials.
const file = await open(envFile, "wx", 0o600).catch(
  (error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST")
      throw new Error(".env.local already exists; leaving it untouched.");
    throw error;
  },
);
try {
  await file.writeFile(contents);
} finally {
  await file.close();
}

const environment = {
  ...process.env,
  APP_ENV_FILE: ".env.local",
  SETUP_MODE: "local",
  TRAEFIK_EXTERNAL: "false",
  TRAEFIK_NETWORK: "music_recommender_local_proxy",
  DOMAIN: "localhost",
  WEB_PORT: "4933",
  POSTGRES_PORT: "55433",
  POSTGRES_USER: "recommender",
  POSTGRES_PASSWORD: password,
  POSTGRES_DB: "recommender",
  DATABASE_URL: databaseUrl,
  DATABASE_INTERNAL_URL: `postgres://recommender:${password}@postgres:5432/recommender`,
  MUSIC_LIBRARY_PATH: musicPath,
  WORKER_TOKEN: workerToken,
  MUSIC_HOST: "",
  MA_TOKEN: "",
  HA_HOST: "",
  TOKEN: "",
  CONFIG_ID: "",
};
function run(command: string[]) {
  const result = Bun.spawnSync(command, {
    cwd: root,
    env: environment,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0)
    throw new Error(
      `${command[0]} failed. Local config is saved in .env.local; see the resume commands in README.md.`,
    );
}
const compose = [
  "docker",
  "compose",
  "--project-name",
  "music-recommender-local",
  "--env-file",
  ".env.local",
];
run([...compose, "--profile", "database", "up", "-d", "postgres"]);
let ready = false;
for (let attempt = 0; attempt < 30; attempt++) {
  const result = Bun.spawnSync(
    [...compose, "exec", "-T", "postgres", "pg_isready", "-U", "recommender"],
    {
      cwd: root,
      env: environment,
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  if (result.exitCode === 0) {
    ready = true;
    break;
  }
  await Bun.sleep(1000);
}
if (!ready)
  throw new Error(
    "Local PostgreSQL did not become ready. Check docker compose logs postgres.",
  );
run(["bun", "--no-env-file", "install", "--frozen-lockfile"]);
run(["bun", "--no-env-file", "run", "db:migrate"]);
run([...compose, "up", "-d", "--build", "web"]);
console.log("\nOpen http://127.0.0.1:4933/register, then visit Setup.");
console.log(
  "To add Music Assistant and Home Assistant later, fill their blank fields in .env.local and restart the web service.",
);
