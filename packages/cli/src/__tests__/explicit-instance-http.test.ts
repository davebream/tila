import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
} from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { InstanceKey } from "@tila/schemas";
import { exportProjectBackup } from "tila-sdk/backup";
import { createTilaLocal } from "tila-sdk/local";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { AuthStore, FakeSecretStore, TilaPaths } from "../auth-store";

/**
 * End-to-end proof, with the real CLI process, that an explicit --instance
 * never lets a command act on the instance of the current directory's project:
 * either the project is provably that instance's, or nothing is sent.
 */

const root = mkdtempSync(join(tmpdir(), "tila-explicit-instance-"));
const home = join(root, "home");
const projectA = join(root, "project-a");
const projectLocal = join(root, "project-local");
const projectDestroy = join(root, "project-destroy");
const projectDisconnect = join(root, "project-disconnect");
const projectDisconnectInvalid = join(root, "project-disconnect-invalid");
const credentialFiles = [".env", ".session", "github-token-cache.json"];
const localDb = join(projectLocal, "state.db");
const entry = resolve(import.meta.dirname, "../index.ts");

interface Recorded {
  method: string;
  url: string;
}
interface FakeServer {
  server: Server;
  url: string;
  requests: Recorded[];
}

const jsonReply = (res: ServerResponse, value: unknown, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
};
const reply = (req: IncomingMessage, res: ServerResponse) => {
  if (req.method === "POST")
    jsonReply(res, {
      ok: true,
      entity: {
        id: "T-explicit",
        type: "task",
        schema_version: 1,
        data: { title: "t", status: "open" },
        archived: 0,
        created_at: 1,
        updated_at: 1,
        created_by: "cli",
        tags: [],
      },
    });
  else
    jsonReply(res, {
      ok: true,
      entities: [],
      total: 0,
      limit: 50,
      offset: 0,
      has_more: false,
      next_cursor: null,
      scope: { restricted: false, archived: "included" },
    });
};
async function startServer(): Promise<FakeServer> {
  const requests: Recorded[] = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? "", url: req.url ?? "" });
    reply(req, res);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test server");
  return { server, url: `http://127.0.0.1:${address.port}`, requests };
}

let a: FakeServer;
let b: FakeServer;

function config(workerUrl: string, projectId: string, extra = "") {
  return `project_id = "${projectId}"\nworker_url = "${workerUrl}"\nschema_version = 1\ntila_version = "0.2.7"\ncreated_at = "2026-10-07T00:00:00Z"\n${extra}`;
}

async function seedRegistry() {
  vi.stubEnv("TILA_HOME", home);
  try {
    const store = new AuthStore({
      paths: new TilaPaths(),
      secrets: new FakeSecretStore(),
      env: { isCI: false, isTTY: true },
    });
    for (const [key, url, trusted] of [
      ["a-key", a.url, true],
      ["b-key", b.url, true],
      ["untrusted-key", b.url, false],
    ] as const) {
      await store.registerInstance({
        instance_key: key as InstanceKey,
        instance_id_source: "server",
        worker_url: url,
      });
      if (trusted) await store.markTrusted(key as InstanceKey);
    }
  } finally {
    vi.unstubAllEnvs();
  }
}

beforeAll(async () => {
  a = await startServer();
  b = await startServer();
  mkdirSync(home, { recursive: true });
  mkdirSync(join(projectA, ".tila"), { recursive: true });
  writeFileSync(join(projectA, ".tila/config.toml"), config(a.url, "proj-a"));
  mkdirSync(join(projectDestroy, ".tila"), { recursive: true });
  writeFileSync(
    join(projectDestroy, ".tila/config.toml"),
    config(a.url, "proj-destroy"),
  );
  writeFileSync(
    join(projectDestroy, ".tila/.env"),
    "TILA_API_TOKEN=destroy-token\n",
  );
  mkdirSync(join(projectDisconnect, ".tila"), { recursive: true });
  writeFileSync(
    join(projectDisconnect, ".tila/config.toml"),
    config(a.url, "proj-disconnect"),
  );
  mkdirSync(join(projectDisconnectInvalid, ".tila"), { recursive: true });
  writeFileSync(
    join(projectDisconnectInvalid, ".tila/config.toml"),
    "this is = [not valid toml\n",
  );
  // Infra-owner destroy by slug acts on the Worker saved here: instance A's.
  writeFileSync(
    join(home, "infra.toml"),
    `account_id = "acct"\naccount_name = "Acct"\nd1_database_id = "d1"\nworker_url = "${a.url}"\n`,
  );
  mkdirSync(join(projectLocal, ".tila"), { recursive: true });
  writeFileSync(
    join(projectLocal, ".tila/config.toml"),
    `project_id = "proj-local"\nbackend = "local"\nschema_version = 1\ntila_version = "0.2.7"\ncreated_at = "2026-10-07T00:00:00Z"\n\n[local]\ndb_path = "${localDb}"\nartifacts_path = "${join(projectLocal, "artifacts")}"\n`,
  );
  await seedRegistry();
});
beforeEach(() => {
  a.requests.length = 0;
  b.requests.length = 0;
});
afterAll(async () => {
  for (const { server } of [a, b])
    await new Promise<void>((done) => server.close(() => done()));
  rmSync(root, { recursive: true, force: true });
});

async function invoke(
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
) {
  const child = spawn("bun", [entry, "--token", "fixture-token", ...args], {
    cwd: options.cwd ?? projectA,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      TILA_HOME: home,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_CACHE_HOME: join(home, "cache"),
      CI: "1",
      CODEX_THREAD_ID: "",
      TILA_LIFECYCLE_KEY: "",
      TILA_RUN_SOCKET: "",
      TILA_RUN_CAPABILITY: "",
      TILA_TOKEN: "",
      TILA_API_TOKEN: "",
      ...options.env,
      NO_COLOR: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (data) => stdout.push(data));
  child.stderr.on("data", (data) => stderr.push(data));
  const status = await new Promise<number | null>((done, fail) => {
    child.on("error", fail);
    child.on("exit", done);
  });
  return {
    status,
    stdout: Buffer.concat(stdout).toString(),
    stderr: Buffer.concat(stderr).toString(),
  };
}

function expectRefusedBeforeAnyRequest(
  result: Awaited<ReturnType<typeof invoke>>,
  message: RegExp,
) {
  expect(result.status, result.stdout + result.stderr).toBe(1);
  const error = JSON.parse(result.stderr).error;
  expect(error.kind).toBe("invalid-argument");
  expect(error.message).toMatch(message);
  expect(a.requests).toEqual([]);
  expect(b.requests).toEqual([]);
}

const READ = ["task", "list", "--json"];
const WRITE = ["task", "new", "explicit", "--id", "T-explicit", "--json"];

describe("explicit --instance is refused before any request unless provably the project's own", () => {
  it("read: cwd bound to A, --instance B sends nothing to A or B", async () => {
    expectRefusedBeforeAnyRequest(
      await invoke(["--instance", "b-key", ...READ]),
      /different deployment/,
    );
  });

  it("write: cwd bound to A, --instance B mutates neither A nor B", async () => {
    expectRefusedBeforeAnyRequest(
      await invoke(["--instance", "b-key", ...WRITE]),
      /different deployment/,
    );
  });

  it("refuses --instance=B in the equals form and when it follows the command", async () => {
    expectRefusedBeforeAnyRequest(
      await invoke(["--instance=b-key", ...READ]),
      /different deployment/,
    );
    expectRefusedBeforeAnyRequest(
      await invoke([...WRITE, "--instance", "b-key"]),
      /different deployment/,
    );
  });

  it("refuses an --instance that is not registered", async () => {
    expectRefusedBeforeAnyRequest(
      await invoke(["--instance", "ghost", ...WRITE]),
      /unknown instance/i,
    );
  });

  it("refuses a registered instance that is not trusted", async () => {
    expectRefusedBeforeAnyRequest(
      await invoke(["--instance", "untrusted-key", ...READ]),
      /not trusted/,
    );
  });

  it("refuses the project's own instance with a --project it cannot verify", async () => {
    expectRefusedBeforeAnyRequest(
      await invoke(["--instance", "a-key", "--project", "proj-b", ...WRITE]),
      /--project "proj-b"/,
    );
  });

  it("refuses an explicit remote --instance from a local project without opening it", async () => {
    expectRefusedBeforeAnyRequest(
      await invoke(["--instance", "a-key", ...WRITE], { cwd: projectLocal }),
      /local project/,
    );
    expect(existsSync(localDb)).toBe(false);
  });

  it("refuses project export, which also reads the directory's project directly", async () => {
    expectRefusedBeforeAnyRequest(
      await invoke([
        "--instance",
        "b-key",
        "project",
        "export",
        "--output",
        join(root, "out.tila-backup"),
        "--json",
      ]),
      /different deployment/,
    );
    expect(existsSync(join(root, "out.tila-backup"))).toBe(false);
  });

  it("refuses admin writes that take the token path (TILA_TOKEN)", async () => {
    expectRefusedBeforeAnyRequest(
      await invoke(["--instance", "b-key", "admin", "list", "--json"], {
        env: { TILA_TOKEN: "env-token" },
      }),
      /different deployment/,
    );
  });
});

describe("project destroy with an explicit --instance", () => {
  const destroyKept = () => [
    existsSync(join(projectDestroy, ".tila/config.toml")),
    existsSync(join(projectDestroy, ".tila/.env")),
  ];

  it("local plan: cwd bound to A, --instance B wipes and deletes nothing", async () => {
    const result = await invoke(
      ["--instance", "b-key", "project", "destroy", "--force", "--json"],
      { cwd: projectDestroy },
    );
    expectRefusedBeforeAnyRequest(result, /different deployment/);
    expect(destroyKept()).toEqual([true, true]);
  });

  it("local plan: refuses an unregistered instance without deleting", async () => {
    const result = await invoke(
      ["--instance", "ghost", "project", "destroy", "--force", "--json"],
      { cwd: projectDestroy },
    );
    expectRefusedBeforeAnyRequest(result, /unknown instance/i);
    expect(destroyKept()).toEqual([true, true]);
  });

  it("local plan: refuses a local project's destroy under an explicit --instance", async () => {
    const result = await invoke(
      ["--instance", "a-key", "project", "destroy", "--force", "--json"],
      { cwd: projectLocal },
    );
    expectRefusedBeforeAnyRequest(result, /local project/);
    expect(existsSync(join(projectLocal, ".tila/config.toml"))).toBe(true);
  });

  it("infra slug plan: --instance B is not a selector and wipes nothing on A", async () => {
    const result = await invoke(
      [
        "--instance",
        "b-key",
        "project",
        "destroy",
        "some-slug",
        "--force",
        "--json",
      ],
      { cwd: projectDestroy },
    );
    expectRefusedBeforeAnyRequest(result, /different deployment/);
    expect(result.stderr).toContain("infra.toml");
    expect(destroyKept()).toEqual([true, true]);
  });

  it("infra slug plan: accepts the instance that is infra.toml's Worker (control)", async () => {
    // With no INFRA_ADMIN_TOKEN the destroy stops right after the guard.
    const result = await invoke(
      [
        "--instance",
        "a-key",
        "project",
        "destroy",
        "some-slug",
        "--force",
        "--json",
      ],
      { cwd: projectDestroy },
    );
    const output = result.stdout + result.stderr;
    expect(result.status).toBe(1);
    expect(output).toContain("INFRA_ADMIN_TOKEN");
    expect(output).not.toContain("different deployment");
    expect(a.requests).toEqual([]);
    expect(b.requests).toEqual([]);
  });
});

describe("project import with an explicit --instance and no project config", () => {
  const importedProject = "import-local-proj";
  const noConfigDir = join(root, "no-config");
  const archive = join(root, "fixture.tila-backup");
  const localState = () => join(home, "projects", importedProject, "state.db");

  beforeAll(async () => {
    mkdirSync(noConfigDir, { recursive: true });
    const source = {
      backend: "local" as const,
      projectId: importedProject,
      dbPath: join(root, "import-source.db"),
      artifactsPath: join(root, "import-source-artifacts"),
    };
    const local = await createTilaLocal({
      dbPath: source.dbPath,
      artifactsPath: source.artifactsPath,
      project: source.projectId,
      org: "local",
      skipFilesystemCheck: true,
    });
    await local.project.create({
      id: "seed",
      type: "task",
      data: { title: "seed", status: "open" },
      created_by: "test",
    });
    local.close();
    await exportProjectBackup({ source, output: archive });
  });

  it("--local --instance B creates no local destination", async () => {
    const result = await invoke(
      [
        "--instance",
        "b-key",
        "project",
        "import",
        archive,
        "--local",
        "--json",
      ],
      { cwd: noConfigDir },
    );
    expectRefusedBeforeAnyRequest(result, /cannot be combined with --local/);
    expect(existsSync(localState())).toBe(false);
  });

  it("refuses before the archive is read", async () => {
    const garbage = join(root, "garbage.tila-backup");
    writeFileSync(garbage, "not an archive");
    const result = await invoke(
      [
        "--instance",
        "b-key",
        "project",
        "import",
        garbage,
        "--local",
        "--json",
      ],
      { cwd: noConfigDir },
    );
    expectRefusedBeforeAnyRequest(result, /cannot be combined with --local/);
  });

  it("without --local an explicit --instance still stops with no destination", async () => {
    const result = await invoke(
      ["--instance", "b-key", "project", "import", archive, "--json"],
      { cwd: noConfigDir },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("No destination project found");
    expect(existsSync(localState())).toBe(false);
  });

  it("without --instance, --local still creates the local destination (control)", async () => {
    const result = await invoke(
      ["project", "import", archive, "--local", "--json"],
      { cwd: noConfigDir },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(existsSync(localState())).toBe(true);
  });
});

describe("disconnect with an explicit --instance", () => {
  const seed = (dir: string) => {
    for (const file of credentialFiles)
      writeFileSync(join(dir, ".tila", file), "synthetic-credential\n");
  };
  const remaining = (dir: string) =>
    credentialFiles.filter((file) => existsSync(join(dir, ".tila", file)));

  beforeEach(() => {
    seed(projectDisconnect);
    seed(projectDisconnectInvalid);
  });

  it("cwd bound to A, --instance B deletes none of A's credential files", async () => {
    const result = await invoke(
      ["--instance", "b-key", "disconnect", "--json"],
      {
        cwd: projectDisconnect,
      },
    );
    expectRefusedBeforeAnyRequest(result, /different deployment/);
    expect(remaining(projectDisconnect)).toEqual(credentialFiles);
    expect(existsSync(join(projectDisconnect, ".tila/config.toml"))).toBe(true);
  });

  it("keeps the files when the instance is unregistered", async () => {
    const result = await invoke(
      ["--instance", "ghost", "disconnect", "--json"],
      {
        cwd: projectDisconnect,
      },
    );
    expectRefusedBeforeAnyRequest(result, /unknown instance/i);
    expect(remaining(projectDisconnect)).toEqual(credentialFiles);
  });

  it("keeps the files when --project is not the directory's project", async () => {
    const result = await invoke(
      ["--instance", "a-key", "--project", "proj-b", "disconnect", "--json"],
      { cwd: projectDisconnect },
    );
    expectRefusedBeforeAnyRequest(result, /--project "proj-b"/);
    expect(remaining(projectDisconnect)).toEqual(credentialFiles);
  });

  it("fails closed, keeping the files, when the config cannot be verified", async () => {
    const result = await invoke(["--instance", "a-key", "disconnect"], {
      cwd: projectDisconnectInvalid,
    });
    expect(result.status).not.toBe(0);
    expect(remaining(projectDisconnectInvalid)).toEqual(credentialFiles);
  });

  it("matching instance still removes the project's credential files (control)", async () => {
    const result = await invoke(["--instance", "a-key", "disconnect"], {
      cwd: projectDisconnect,
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(remaining(projectDisconnect)).toEqual([]);
    expect(existsSync(join(projectDisconnect, ".tila/config.toml"))).toBe(true);
    expect(a.requests).toEqual([]);
    expect(b.requests).toEqual([]);
  });

  it("without --instance still removes the files, even if config.toml is unparseable", async () => {
    for (const dir of [projectDisconnect, projectDisconnectInvalid]) {
      const result = await invoke(["disconnect"], { cwd: dir });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(remaining(dir)).toEqual([]);
    }
  });
});

describe("explicit --instance that is provably the project's own", () => {
  it("read: acts on the project in the directory", async () => {
    const result = await invoke(["--instance", "a-key", ...READ]);
    expect(result.status, result.stderr).toBe(0);
    expect(a.requests).toHaveLength(1);
    expect(a.requests[0].url).toContain("/projects/proj-a/tasks?");
    expect(b.requests).toEqual([]);
  });

  it("write: acts on the project in the directory", async () => {
    const result = await invoke([
      "--instance",
      "a-key",
      "--project",
      "proj-a",
      ...WRITE,
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(a.requests).toEqual([
      { method: "POST", url: "/projects/proj-a/tasks" },
    ]);
    expect(b.requests).toEqual([]);
  });
});

describe("implicit cwd behavior without --instance", () => {
  it("read: still acts on the project in the directory", async () => {
    const result = await invoke(READ);
    expect(result.status, result.stderr).toBe(0);
    expect(a.requests).toHaveLength(1);
    expect(b.requests).toEqual([]);
  });

  it("write: still acts on the project in the directory", async () => {
    const result = await invoke(WRITE);
    expect(result.status, result.stderr).toBe(0);
    expect(a.requests).toEqual([
      { method: "POST", url: "/projects/proj-a/tasks" },
    ]);
    expect(b.requests).toEqual([]);
  });
});
