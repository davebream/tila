// Deploys a disposable Worker for the pre-tag live gates, with its own D1
// database, DO namespace and R2 bucket. Never touches the production instance.
//
// Usage (from the repo root):
//   TILA_HOME=<gate-home> bun --tsconfig-override <repo>/tsconfig.json \
//     .agents/skills/tila-release/scripts/provision-gate-infra.ts \
//     --slug tila-rel070 [--repo <checkout>] [--d1 <name>] [--r2 <name>]
//
// --repo   checkout whose Worker is deployed (default: cwd). Pass an older
//          release worktree for an A/B comparison.
// --d1/--r2 default to <slug>-global / <slug>-artifacts. Pass the names of an
//          existing gate deployment to add a second Worker script to it.
//
// `tila infra provision` is not usable here: it hard-codes the production D1
// and R2 names (packages/cli/src/lib/resource-names.ts).
import { randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    slug: { type: "string" },
    repo: { type: "string", default: process.cwd() },
    d1: { type: "string" },
    r2: { type: "string" },
  },
});
const slug = values.slug;
if (!slug || !/^tila-rel[a-z0-9-]+$/.test(slug)) {
  throw new Error("--slug is required and must start with tila-rel");
}
const repo = resolve(values.repo as string);
const d1Name = values.d1 ?? `${slug}-global`;
const r2Name = values.r2 ?? `${slug}-artifacts`;

const gateHome = process.env.TILA_HOME;
const prodHome = join(homedir(), ".tila");
if (!gateHome || resolve(gateHome) === resolve(prodHome)) {
  throw new Error("Set TILA_HOME to a disposable directory, not ~/.tila");
}
mkdirSync(gateHome, { recursive: true, mode: 0o700 });
if (!existsSync(join(gateHome, ".env"))) {
  copyFileSync(join(prodHome, ".env"), join(gateHome, ".env"));
}

// Production identifiers, read from the operator's real infra config.
function prodValue(key: string): string | undefined {
  const file = join(prodHome, "infra.toml");
  if (!existsSync(file)) return undefined;
  const match = readFileSync(file, "utf8").match(
    new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m"),
  );
  return match?.[1];
}
const prod = {
  d1Id: prodValue("d1_database_id"),
  r2: prodValue("r2_bucket_name") ?? "tila-artifacts",
  slug: prodValue("infra_slug") ?? "tila",
};
if (
  [prod.slug, "tila"].includes(slug) ||
  [prod.r2, "tila-artifacts"].includes(r2Name) ||
  d1Name === "tila-global"
) {
  throw new Error("Refusing to use production resource names");
}

const lib = (file: string) => import(join(repo, "packages/cli/src/lib", file));
const { createCloudflareClient } = await lib("cloudflare-client");
const {
  applyD1Migrations,
  applyR2Lifecycle,
  ensureR2Bucket,
  queryD1,
  setWorkerSecrets,
} = await lib("cloudflare-resources");
const { deployWorkerWithAssets } = await lib("deploy");
const { readWorkerSettings, resolveDeploymentSettings } = await lib(
  "deployment-settings",
);
const { writeInfraConfig } = await lib("infra-config");
const { generateHmacKey, resolveCfApiToken, resolveMigrationsDir } =
  await lib("provisioning");

// deployWorkerWithAssets shells out to pnpm and wrangler relative to cwd.
process.chdir(join(repo, "packages/cli"));

const token = resolveCfApiToken();
if (!token) throw new Error("No CLOUDFLARE_API_TOKEN in TILA_HOME/.env");
type CfList = { result?: Array<{ id?: string; name: string; uuid?: string }> };
const cfApi = async (path: string) =>
  (await fetch(`https://api.cloudflare.com/client/v4/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then((r) => r.json())) as CfList;
const cf = createCloudflareClient(token);
const account = (await cfApi("accounts")).result?.[0];
if (!account?.id)
  throw new Error("No Cloudflare account visible to this token");

// Verify the endpoint and preserve an existing gate Worker's settings before
// creating storage. Only a confirmed missing Worker permits deployment defaults.
const worker = await readWorkerSettings(cf, account.id, slug, true);
const deployment = await resolveDeploymentSettings({
  cf,
  accountId: account.id,
  scriptName: slug,
  worker,
});

const existing = await cfApi(
  `accounts/${account.id}/d1/database?name=${encodeURIComponent(d1Name)}`,
);
let d1Id: string | undefined = existing.result?.find(
  (d: { name: string }) => d.name === d1Name,
)?.uuid;
if (!d1Id) {
  d1Id = (await cf.d1.database.create({ account_id: account.id, name: d1Name }))
    .uuid as string;
}
if (d1Id === prod.d1Id) throw new Error("Refusing production D1 database");

await applyD1Migrations(cf, account.id, d1Id, resolveMigrationsDir());
await queryD1(
  cf,
  account.id,
  d1Id,
  "INSERT INTO _deployment_meta (id, instance_id, created_at) VALUES (1, ?, ?) ON CONFLICT(id) DO NOTHING",
  [randomUUID(), String(Date.now())],
);
await ensureR2Bucket(cf, account.id, r2Name);
await applyR2Lifecycle(cf, account.id, r2Name);

const deployed = await deployWorkerWithAssets({
  cf,
  accountId: account.id,
  scriptName: slug,
  d1DatabaseId: d1Id,
  r2BucketName: r2Name,
  apiToken: token,
  skipUi: false,
  settings: deployment.settings,
  workerUrl: deployment.workerUrl,
});
const hmac = generateHmacKey();
const infraAdmin = randomBytes(32).toString("hex");
await setWorkerSecrets(cf, account.id, slug, {
  GITHUB_SESSION_HMAC_KEY: hmac,
  INFRA_ADMIN_TOKEN: infraAdmin,
  CONVERSATION_CURSOR_KEY: randomBytes(32).toString("base64"),
});
writeInfraConfig(
  {
    account_id: account.id,
    account_name: account.name,
    d1_database_id: d1Id,
    worker_url: deployed.workerUrl,
    r2_bucket_name: r2Name,
    hmac_key: hmac,
    infra_admin_token: infraAdmin,
    infra_slug: slug,
  },
  gateHome,
);
console.log(
  JSON.stringify({
    slug,
    worker_url: deployed.workerUrl,
    d1: d1Name,
    d1_id: d1Id,
    r2: r2Name,
  }),
);
