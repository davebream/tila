import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TARGET_DEFS,
  buildMcpEntry,
  detectEditors,
  mergeMcpEntry,
  runMcpInit,
  stripJsoncComments,
} from "../../lib/mcp-targets";

vi.mock("@clack/prompts", () => ({
  text: vi.fn(),
  password: vi.fn(),
  confirm: vi.fn().mockResolvedValue(true),
  select: vi.fn(),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  note: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    step: vi.fn(),
    success: vi.fn(),
    message: vi.fn(),
  },
}));

// ─── buildMcpEntry ───────────────────────────────────────────────────────────

describe("buildMcpEntry", () => {
  it("returns placeholder strings when no config provided", () => {
    const entry = buildMcpEntry();
    expect(entry.command).toBe("npx");
    expect(entry.args).toEqual(["-y", "tila-mcp-server"]);
    expect(entry.env.TILA_API_TOKEN).toBe("${TILA_API_TOKEN}");
    expect(entry.env.TILA_API_URL).toBe("${TILA_API_URL}");
    expect(entry.env.TILA_PROJECT_ID).toBe("${TILA_PROJECT_ID}");
  });

  it("uses concrete apiUrl and projectId when provided", () => {
    const entry = buildMcpEntry({
      apiUrl: "https://tila-myproj.workers.dev",
      projectId: "myproj-abc123",
    });
    expect(entry.env.TILA_API_URL).toBe("https://tila-myproj.workers.dev");
    expect(entry.env.TILA_PROJECT_ID).toBe("myproj-abc123");
    // Token always remains a placeholder
    expect(entry.env.TILA_API_TOKEN).toBe("${TILA_API_TOKEN}");
  });

  it("uses placeholder for apiUrl when only projectId provided", () => {
    const entry = buildMcpEntry({ projectId: "myproj" });
    expect(entry.env.TILA_API_URL).toBe("${TILA_API_URL}");
    expect(entry.env.TILA_PROJECT_ID).toBe("myproj");
  });

  it("includes TILA_API_TOKEN when authMode is tila-token", () => {
    const entry = buildMcpEntry({ authMode: "tila-token" });
    expect(entry.env.TILA_API_TOKEN).toBe("${TILA_API_TOKEN}");
  });

  it("omits TILA_API_TOKEN when authMode is github-repo", () => {
    const entry = buildMcpEntry({ authMode: "github-repo" });
    expect(entry.env.TILA_API_TOKEN).toBeUndefined();
  });

  it("includes TILA_API_TOKEN when authMode is undefined (backward compat)", () => {
    const entry = buildMcpEntry({});
    expect(entry.env.TILA_API_TOKEN).toBe("${TILA_API_TOKEN}");
  });

  it("omits TILA_API_TOKEN in github-repo mode with concrete values", () => {
    const entry = buildMcpEntry({
      apiUrl: "https://tila-myproj.workers.dev",
      projectId: "myproj-abc123",
      authMode: "github-repo",
    });
    expect(entry.env.TILA_API_URL).toBe("https://tila-myproj.workers.dev");
    expect(entry.env.TILA_PROJECT_ID).toBe("myproj-abc123");
    expect(entry.env.TILA_API_TOKEN).toBeUndefined();
  });
});

// ─── stripJsoncComments ──────────────────────────────────────────────────────

describe("stripJsoncComments", () => {
  it("passes through JSON with no comments unchanged", () => {
    const src = '{"key": "value", "num": 42}';
    expect(stripJsoncComments(src)).toBe(src);
  });

  it("removes line comments", () => {
    const src = `{
  // this is a comment
  "key": "value"
}`;
    const result = stripJsoncComments(src);
    expect(result).not.toContain("// this is a comment");
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed.key).toBe("value");
  });

  it("removes block comments", () => {
    const src = `{
  /* block comment */
  "key": "value"
}`;
    const result = stripJsoncComments(src);
    expect(result).not.toContain("block comment");
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed.key).toBe("value");
  });

  it("removes mixed line and block comments", () => {
    const src = `{
  // line comment
  "servers": {
    /* block
       comment */
    "existing": {}
  }
}`;
    const result = stripJsoncComments(src);
    expect(result).not.toContain("line comment");
    expect(result).not.toContain("block");
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed.servers).toBeDefined();
  });

  it("removes trailing line comments after values", () => {
    const src = '{"key": "value" // trailing\n}';
    const result = stripJsoncComments(src);
    expect(result).not.toContain("trailing");
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed.key).toBe("value");
  });

  it("preserves URLs with // inside string values", () => {
    const src = '{"url": "https://example.com/path"}';
    const result = stripJsoncComments(src);
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed.url).toBe("https://example.com/path");
  });

  it("preserves placeholder strings with ${} inside string values", () => {
    const src = '{"token": "${TILA_API_TOKEN}"}';
    const result = stripJsoncComments(src);
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed.token).toBe("${TILA_API_TOKEN}");
  });
});

// ─── TARGET_DEFS ────────────────────────────────────────────────────────────

describe("TARGET_DEFS", () => {
  it("has exactly 5 entries", () => {
    expect(TARGET_DEFS).toHaveLength(5);
  });

  it("has correct slugs", () => {
    const slugs = TARGET_DEFS.map((t) => t.slug);
    expect(slugs).toContain("claude-code");
    expect(slugs).toContain("cursor");
    expect(slugs).toContain("vscode-copilot");
    expect(slugs).toContain("cline");
    expect(slugs).toContain("codex-cli");
  });

  it("vscode-copilot uses servers key", () => {
    const vscode = TARGET_DEFS.find((t) => t.slug === "vscode-copilot");
    expect(vscode?.topLevelKey).toBe("servers");
  });

  it("all non-vscode targets use mcpServers key", () => {
    for (const target of TARGET_DEFS.filter(
      (t) => t.slug !== "vscode-copilot",
    )) {
      expect(target.topLevelKey).toBe("mcpServers");
    }
  });

  it("cline has printSnippetOnly: true", () => {
    const cline = TARGET_DEFS.find((t) => t.slug === "cline");
    expect(cline?.printSnippetOnly).toBe(true);
  });

  it("cline has empty configPath", () => {
    const cline = TARGET_DEFS.find((t) => t.slug === "cline");
    expect(cline?.configPath).toBe("");
  });

  it("non-cline targets have printSnippetOnly: false", () => {
    for (const target of TARGET_DEFS.filter((t) => t.slug !== "cline")) {
      expect(target.printSnippetOnly).toBe(false);
    }
  });
});

// ─── mergeMcpEntry ──────────────────────────────────────────────────────────

describe("mergeMcpEntry", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "tila-mcp-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const entry = buildMcpEntry({
    apiUrl: "https://tila-test.workers.dev",
    projectId: "test-proj",
  });

  it("creates a new file with correct JSON structure when file does not exist", () => {
    const filePath = join(tempDir, ".mcp.json");
    const result = mergeMcpEntry(filePath, "mcpServers", entry, false);

    expect(result.status).toBe("written");
    expect(existsSync(filePath)).toBe(true);

    const content = JSON.parse(readFileSync(filePath, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(content.mcpServers).toBeDefined();
    const servers = content.mcpServers as Record<string, unknown>;
    expect(servers.tila).toEqual(entry);
  });

  it("preserves existing entries when merging", () => {
    const filePath = join(tempDir, ".mcp.json");
    const existing = {
      mcpServers: {
        "other-server": { command: "node", args: ["other.js"], env: {} },
      },
    };
    writeFileSync(filePath, JSON.stringify(existing, null, 2), "utf-8");

    const result = mergeMcpEntry(filePath, "mcpServers", entry, false);

    expect(result.status).toBe("written");
    const content = JSON.parse(readFileSync(filePath, "utf-8")) as Record<
      string,
      unknown
    >;
    const servers = content.mcpServers as Record<string, unknown>;
    expect(servers["other-server"]).toBeDefined();
    expect(servers.tila).toEqual(entry);
  });

  it("strips JSONC comments before parsing", () => {
    const filePath = join(tempDir, ".mcp.json");
    const withComments = `{
  // This is a comment
  "mcpServers": {
    /* existing entry */
    "other": {}
  }
}`;
    writeFileSync(filePath, withComments, "utf-8");

    const result = mergeMcpEntry(filePath, "mcpServers", entry, false);
    expect(result.status).toBe("written");
    const content = JSON.parse(readFileSync(filePath, "utf-8")) as Record<
      string,
      unknown
    >;
    const servers = content.mcpServers as Record<string, unknown>;
    expect(servers.tila).toEqual(entry);
    expect(servers.other).toBeDefined();
  });

  it("returns already-configured when tila entry is identical", () => {
    const filePath = join(tempDir, ".mcp.json");
    const existing = { mcpServers: { tila: entry } };
    writeFileSync(filePath, JSON.stringify(existing, null, 2), "utf-8");

    const result = mergeMcpEntry(filePath, "mcpServers", entry, false);
    expect(result.status).toBe("already-configured");

    // File should be unchanged
    const content = readFileSync(filePath, "utf-8");
    expect(JSON.parse(content)).toEqual(existing);
  });

  it("writes with 2-space indentation and trailing newline", () => {
    const filePath = join(tempDir, ".mcp.json");
    mergeMcpEntry(filePath, "mcpServers", entry, false);

    const content = readFileSync(filePath, "utf-8");
    expect(content).toMatch(/^{\n {2}/);
    expect(content.endsWith("\n")).toBe(true);
  });

  it("dry-run returns content without creating file", () => {
    const filePath = join(tempDir, ".mcp.json");
    const result = mergeMcpEntry(filePath, "mcpServers", entry, true);

    expect(result.status).toBe("dry-run");
    if (result.status === "dry-run") {
      const parsed = JSON.parse(result.content) as Record<string, unknown>;
      expect((parsed.mcpServers as Record<string, unknown>).tila).toEqual(
        entry,
      );
    }
    // File must NOT be created
    expect(existsSync(filePath)).toBe(false);
  });

  it("dry-run on existing file returns merged content without modifying file", () => {
    const filePath = join(tempDir, ".mcp.json");
    const existing = { mcpServers: { other: {} } };
    writeFileSync(filePath, JSON.stringify(existing, null, 2), "utf-8");
    const originalContent = readFileSync(filePath, "utf-8");

    const result = mergeMcpEntry(filePath, "mcpServers", entry, true);

    expect(result.status).toBe("dry-run");
    // File unchanged
    expect(readFileSync(filePath, "utf-8")).toBe(originalContent);
  });

  it("uses servers key for VS Code target", () => {
    const filePath = join(tempDir, "mcp.json");
    const result = mergeMcpEntry(filePath, "servers", entry, false);

    expect(result.status).toBe("written");
    const content = JSON.parse(readFileSync(filePath, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(content.servers).toBeDefined();
    expect(content.mcpServers).toBeUndefined();
    const servers = content.servers as Record<string, unknown>;
    expect(servers.tila).toEqual(entry);
  });

  it("creates parent directories when they do not exist", () => {
    const filePath = join(tempDir, ".cursor", "mcp.json");
    const result = mergeMcpEntry(filePath, "mcpServers", entry, false);

    expect(result.status).toBe("written");
    expect(existsSync(filePath)).toBe(true);
  });

  it("throws on invalid JSON after stripping comments", () => {
    const filePath = join(tempDir, "bad.json");
    writeFileSync(filePath, "not json at all", "utf-8");

    expect(() => mergeMcpEntry(filePath, "mcpServers", entry, false)).toThrow(
      "is not valid JSON after stripping comments",
    );
  });
});

// ─── detectEditors ──────────────────────────────────────────────────────────

describe("detectEditors", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "tila-detect-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns empty array when no editor markers exist", () => {
    const result = detectEditors(tempDir);
    expect(result).toEqual([]);
  });

  it("detects cursor when .cursor/ directory exists", () => {
    mkdirSync(join(tempDir, ".cursor"));
    const result = detectEditors(tempDir);
    const slugs = result.map((t) => t.slug);
    expect(slugs).toContain("cursor");
  });

  it("detects vscode when .vscode/ directory exists", () => {
    mkdirSync(join(tempDir, ".vscode"));
    const result = detectEditors(tempDir);
    const slugs = result.map((t) => t.slug);
    expect(slugs).toContain("vscode-copilot");
  });

  it("detects multiple editors", () => {
    mkdirSync(join(tempDir, ".cursor"));
    mkdirSync(join(tempDir, ".vscode"));
    mkdirSync(join(tempDir, ".cline"));
    const result = detectEditors(tempDir);
    const slugs = result.map((t) => t.slug);
    expect(slugs).toContain("cursor");
    expect(slugs).toContain("vscode-copilot");
    expect(slugs).toContain("cline");
  });

  it("detects claude-code when .mcp.json exists", () => {
    writeFileSync(join(tempDir, ".mcp.json"), "{}", "utf-8");
    const result = detectEditors(tempDir);
    const slugs = result.map((t) => t.slug);
    expect(slugs).toContain("claude-code");
  });

  it("detects cline when .cline/ directory exists (returns full TargetDef)", () => {
    mkdirSync(join(tempDir, ".cline"));
    const result = detectEditors(tempDir);
    const cline = result.find((t) => t.slug === "cline");
    expect(cline).toBeDefined();
    expect(cline?.printSnippetOnly).toBe(true);
  });

  it("detects codex-cli when .codex/ directory exists", () => {
    mkdirSync(join(tempDir, ".codex"));
    const result = detectEditors(tempDir);
    const slugs = result.map((t) => t.slug);
    expect(slugs).toContain("codex-cli");
  });
});

// ─── runMcpInit ─────────────────────────────────────────────────────────────

describe("runMcpInit", () => {
  let tempDir: string;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "tila-run-test-"));
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.clearAllMocks();
    vi.mocked(p.confirm).mockResolvedValue(true);
    vi.mocked(p.isCancel).mockReturnValue(false);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    consoleSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("writes to claude-code target when explicitly specified", async () => {
    await runMcpInit({
      targets: ["claude-code"],
      dryRun: false,
      cwd: tempDir,
    });

    const filePath = join(tempDir, ".mcp.json");
    expect(existsSync(filePath)).toBe(true);
    const content = JSON.parse(readFileSync(filePath, "utf-8")) as Record<
      string,
      unknown
    >;
    expect((content.mcpServers as Record<string, unknown>).tila).toBeDefined();
  });

  it("writes to cursor target when explicitly specified", async () => {
    await runMcpInit({
      targets: ["cursor"],
      dryRun: false,
      cwd: tempDir,
    });

    const filePath = join(tempDir, ".cursor", "mcp.json");
    expect(existsSync(filePath)).toBe(true);
  });

  it("uses VS Code servers key for vscode-copilot target", async () => {
    await runMcpInit({
      targets: ["vscode-copilot"],
      dryRun: false,
      cwd: tempDir,
    });

    const filePath = join(tempDir, ".vscode", "mcp.json");
    expect(existsSync(filePath)).toBe(true);
    const content = JSON.parse(readFileSync(filePath, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(content.servers).toBeDefined();
    expect(content.mcpServers).toBeUndefined();
  });

  it("cline target prints snippet without writing a file", async () => {
    await runMcpInit({
      targets: ["cline"],
      dryRun: false,
      cwd: tempDir,
    });

    // No file should be written
    expect(existsSync(join(tempDir, ".cline"))).toBe(false);
    // Snippet should be shown via p.note
    expect(vi.mocked(p.note)).toHaveBeenCalledWith(
      expect.stringContaining("tila-mcp-server"),
      expect.stringContaining("cline"),
    );
  });

  it("prints error and skips for unknown target slug", async () => {
    await runMcpInit({
      targets: ["unknown-editor"],
      dryRun: false,
      cwd: tempDir,
    });

    expect(vi.mocked(p.log.info)).toHaveBeenCalledWith(
      expect.stringContaining("Unknown target: unknown-editor"),
    );
  });

  it("warns about placeholder values when no config found", async () => {
    await runMcpInit({
      targets: ["claude-code"],
      dryRun: false,
      cwd: tempDir,
    });

    expect(vi.mocked(p.log.info)).toHaveBeenCalledWith(
      expect.stringContaining("placeholder"),
    );
  });

  it("uses concrete config values when .tila/config.toml exists", async () => {
    // Create a minimal config.toml
    const tilaDir = join(tempDir, ".tila");
    mkdirSync(tilaDir, { recursive: true });
    const toml = `project_id = "test-abc123"
worker_url = "https://tila-test.workers.dev"
schema_version = 1
tila_version = "0.1.0"
created_at = "2026-01-01T00:00:00.000Z"

[cloudflare]
account_id = "acc-123"

[backends]
entity = "do-sqlite"
coordination = "do-sqlite"
artifact = "r2"
auth = "d1"
`;
    writeFileSync(join(tilaDir, "config.toml"), toml, "utf-8");

    await runMcpInit({
      targets: ["claude-code"],
      dryRun: false,
      cwd: tempDir,
    });

    const filePath = join(tempDir, ".mcp.json");
    const content = JSON.parse(readFileSync(filePath, "utf-8")) as Record<
      string,
      unknown
    >;
    const tilaEntry = (content.mcpServers as Record<string, unknown>)
      .tila as Record<string, unknown>;
    const env = tilaEntry.env as Record<string, string>;
    expect(env.TILA_API_URL).toBe("https://tila-test.workers.dev");
    expect(env.TILA_PROJECT_ID).toBe("test-abc123");
    // Token is always placeholder
    expect(env.TILA_API_TOKEN).toBe("${TILA_API_TOKEN}");
  });

  it("dry-run does not write files", async () => {
    await runMcpInit({
      targets: ["claude-code"],
      dryRun: true,
      cwd: tempDir,
    });

    expect(existsSync(join(tempDir, ".mcp.json"))).toBe(false);
    expect(vi.mocked(p.note)).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("[dry-run]"),
    );
  });

  it("auto-detects and exits silently when no editors detected and targets is empty", async () => {
    // Empty temp dir — no editors
    await runMcpInit({ targets: [], dryRun: false, cwd: tempDir });

    expect(vi.mocked(p.log.info)).toHaveBeenCalledWith(
      expect.stringContaining("No supported editor config detected"),
    );
  });
});
