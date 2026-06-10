import { afterEach, describe, expect, it, vi } from "vitest";

// Must mock fs and smol-toml before importing config
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ""),
    writeFileSync: vi.fn(),
  };
});

import { existsSync, readFileSync } from "node:fs";
import { resolveServerConfig } from "../config";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

// Minimal valid config.toml content for tila-token mode
const TILA_TOKEN_CONFIG_TOML = `
project_id = "proj-123"
worker_url = "https://tila.example.com"
schema_version = 1
tila_version = "0.1.0"
created_at = "2026-01-01T00:00:00Z"

[auth]
mode = "tila-token"
`;

// Config.toml with github-repo mode and [github] section
const GITHUB_REPO_CONFIG_TOML = `
project_id = "proj-github-456"
worker_url = "https://tila.example.com"
schema_version = 1
tila_version = "0.1.0"
created_at = "2026-01-01T00:00:00Z"

[auth]
mode = "github-repo"

[github]
owner = "myorg"
repo = "myrepo"
`;

// Config.toml with github-repo mode but missing [github] section
const GITHUB_REPO_NO_GITHUB_SECTION_TOML = `
project_id = "proj-no-github"
worker_url = "https://tila.example.com"
schema_version = 1
tila_version = "0.1.0"
created_at = "2026-01-01T00:00:00Z"

[auth]
mode = "github-repo"
`;

// Config.toml with github-repo mode but missing worker_url
const GITHUB_REPO_NO_WORKER_URL_TOML = `
project_id = "proj-no-url"
schema_version = 1
tila_version = "0.1.0"
created_at = "2026-01-01T00:00:00Z"

[auth]
mode = "github-repo"

[github]
owner = "myorg"
repo = "myrepo"
`;

describe("resolveServerConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue("");
  });

  describe("tila-token mode (backward compat)", () => {
    it("throws actionable error when TILA_API_TOKEN is missing", async () => {
      vi.stubEnv("TILA_API_URL", "https://tila.example.com");
      vi.stubEnv("TILA_PROJECT_ID", "proj-123");
      vi.stubEnv("TILA_API_TOKEN", "");
      // No TILA_API_TOKEN set, no .tila/.env file (existsSync always returns false)
      await expect(resolveServerConfig()).rejects.toThrow("TILA_API_TOKEN");
    });

    it("throws actionable error when TILA_API_URL is missing", async () => {
      vi.stubEnv("TILA_API_TOKEN", "test-token");
      vi.stubEnv("TILA_PROJECT_ID", "proj-123");
      vi.stubEnv("TILA_API_URL", "");
      // No TILA_API_URL set, no config.toml (existsSync always returns false)
      await expect(resolveServerConfig()).rejects.toThrow("TILA_API_URL");
    });

    it("throws actionable error when TILA_PROJECT_ID is missing", async () => {
      vi.stubEnv("TILA_API_URL", "https://tila.example.com");
      vi.stubEnv("TILA_API_TOKEN", "test-token");
      vi.stubEnv("TILA_PROJECT_ID", "");
      // No TILA_PROJECT_ID set, no config.toml (existsSync always returns false)
      await expect(resolveServerConfig()).rejects.toThrow("TILA_PROJECT_ID");
    });

    it("resolves config from environment variables and returns getToken function", async () => {
      vi.stubEnv("TILA_API_URL", "https://tila.example.com");
      vi.stubEnv("TILA_API_TOKEN", "test-token");
      vi.stubEnv("TILA_PROJECT_ID", "proj-123");

      const config = await resolveServerConfig();

      expect(config.mode).toBe("remote");
      if (config.mode !== "remote") throw new Error("expected remote mode");
      expect(config.apiUrl).toBe("https://tila.example.com");
      expect(config.projectId).toBe("proj-123");
      expect(config.authMode).toBe("tila-token");
      expect(typeof config.getToken).toBe("function");

      // getToken resolves to the static token
      const token = await config.getToken();
      expect(token).toBe("test-token");
    });

    it("resolves config from config.toml when env vars not set", async () => {
      vi.stubEnv("TILA_API_URL", "");
      vi.stubEnv("TILA_API_TOKEN", "env-token");
      vi.stubEnv("TILA_PROJECT_ID", "");

      // Mock finding config.toml
      mockExistsSync.mockImplementation((path: unknown) => {
        return String(path).endsWith("config.toml");
      });
      mockReadFileSync.mockImplementation((path: unknown) => {
        if (String(path).endsWith("config.toml")) {
          return TILA_TOKEN_CONFIG_TOML;
        }
        return "";
      });

      const config = await resolveServerConfig();

      expect(config.mode).toBe("remote");
      if (config.mode !== "remote") throw new Error("expected remote mode");
      expect(config.apiUrl).toBe("https://tila.example.com");
      expect(config.projectId).toBe("proj-123");
      expect(config.authMode).toBe("tila-token");

      const token = await config.getToken();
      expect(token).toBe("env-token");
    });
  });

  describe("github-repo mode", () => {
    it("returns config with getToken function in github-repo mode", async () => {
      vi.stubEnv("TILA_API_URL", "");
      vi.stubEnv("TILA_API_TOKEN", "");
      vi.stubEnv("TILA_PROJECT_ID", "");

      // Mock config.toml with github-repo mode
      mockExistsSync.mockImplementation((path: unknown) => {
        return String(path).endsWith("config.toml");
      });
      mockReadFileSync.mockImplementation((path: unknown) => {
        if (String(path).endsWith("config.toml")) {
          return GITHUB_REPO_CONFIG_TOML;
        }
        return "";
      });

      const config = await resolveServerConfig();

      expect(config.mode).toBe("remote");
      if (config.mode !== "remote") throw new Error("expected remote mode");
      expect(config.apiUrl).toBe("https://tila.example.com");
      expect(config.projectId).toBe("proj-github-456");
      expect(config.authMode).toBe("github-repo");
      expect(typeof config.getToken).toBe("function");
    });

    it("throws actionable error when github-repo mode but [github] section is missing", async () => {
      vi.stubEnv("TILA_API_URL", "");
      vi.stubEnv("TILA_API_TOKEN", "");
      vi.stubEnv("TILA_PROJECT_ID", "");

      mockExistsSync.mockImplementation((path: unknown) => {
        return String(path).endsWith("config.toml");
      });
      mockReadFileSync.mockImplementation((path: unknown) => {
        if (String(path).endsWith("config.toml")) {
          return GITHUB_REPO_NO_GITHUB_SECTION_TOML;
        }
        return "";
      });

      await expect(resolveServerConfig()).rejects.toThrow("[github]");
    });

    it("throws actionable error when github-repo mode but worker_url is missing", async () => {
      vi.stubEnv("TILA_API_URL", "");
      vi.stubEnv("TILA_API_TOKEN", "");
      vi.stubEnv("TILA_PROJECT_ID", "");

      mockExistsSync.mockImplementation((path: unknown) => {
        return String(path).endsWith("config.toml");
      });
      mockReadFileSync.mockImplementation((path: unknown) => {
        if (String(path).endsWith("config.toml")) {
          return GITHUB_REPO_NO_WORKER_URL_TOML;
        }
        return "";
      });

      await expect(resolveServerConfig()).rejects.toThrow("worker_url");
    });

    it("does not require TILA_API_TOKEN in github-repo mode", async () => {
      vi.stubEnv("TILA_API_URL", "");
      vi.stubEnv("TILA_API_TOKEN", ""); // explicitly not set
      vi.stubEnv("TILA_PROJECT_ID", "");

      mockExistsSync.mockImplementation((path: unknown) => {
        return String(path).endsWith("config.toml");
      });
      mockReadFileSync.mockImplementation((path: unknown) => {
        if (String(path).endsWith("config.toml")) {
          return GITHUB_REPO_CONFIG_TOML;
        }
        return "";
      });

      // Should not throw about missing TILA_API_TOKEN
      const config = await resolveServerConfig();
      expect(config.mode).toBe("remote");
      if (config.mode !== "remote") throw new Error("expected remote mode");
      expect(config.authMode).toBe("github-repo");
    });
  });

  describe("local backend mode (backend = local)", () => {
    // backend = local with a full [local] section; intentionally no worker_url/token.
    const LOCAL_CONFIG_TOML = `
project_id = "proj-local-789"
backend = "local"
schema_version = 1
tila_version = "0.1.0"
created_at = "2026-01-01T00:00:00Z"

[local]
db_path = "/tmp/tila/local.db"
artifacts_path = "/tmp/tila/artifacts"
org = "acme"
`;

    function mockLocalConfig(toml: string): void {
      mockExistsSync.mockImplementation((path: unknown) =>
        String(path).endsWith("config.toml"),
      );
      mockReadFileSync.mockImplementation((path: unknown) =>
        String(path).endsWith("config.toml") ? toml : "",
      );
    }

    it("resolves local config WITHOUT requiring worker_url or token", async () => {
      vi.stubEnv("TILA_API_URL", "");
      vi.stubEnv("TILA_API_TOKEN", "");
      vi.stubEnv("TILA_PROJECT_ID", "");
      vi.stubEnv("TILA_DB_PATH", "");
      vi.stubEnv("TILA_ARTIFACTS_PATH", "");
      vi.stubEnv("TILA_ORG", "");

      mockLocalConfig(LOCAL_CONFIG_TOML);

      // Must not throw on missing worker_url / TILA_API_TOKEN.
      const config = await resolveServerConfig();

      expect(config.mode).toBe("local");
      if (config.mode !== "local") throw new Error("expected local mode");
      expect(config.projectId).toBe("proj-local-789");
      expect(config.dbPath).toBe("/tmp/tila/local.db");
      expect(config.artifactsPath).toBe("/tmp/tila/artifacts");
      expect(config.org).toBe("acme");
    });

    it("falls back to TILA_* env for db/artifacts paths and project id", async () => {
      // [local] section omits db_path/artifacts_path; env provides them.
      const LOCAL_NO_PATHS_TOML = `
project_id = "proj-local-env"
backend = "local"
schema_version = 1
tila_version = "0.1.0"
created_at = "2026-01-01T00:00:00Z"
`;
      vi.stubEnv("TILA_API_URL", "");
      vi.stubEnv("TILA_API_TOKEN", "");
      vi.stubEnv("TILA_PROJECT_ID", "proj-env-override");
      vi.stubEnv("TILA_DB_PATH", "/env/db.sqlite");
      vi.stubEnv("TILA_ARTIFACTS_PATH", "/env/artifacts");
      vi.stubEnv("TILA_ORG", "env-org");

      mockLocalConfig(LOCAL_NO_PATHS_TOML);

      const config = await resolveServerConfig();

      expect(config.mode).toBe("local");
      if (config.mode !== "local") throw new Error("expected local mode");
      // TILA_PROJECT_ID env takes precedence over config.project_id.
      expect(config.projectId).toBe("proj-env-override");
      expect(config.dbPath).toBe("/env/db.sqlite");
      expect(config.artifactsPath).toBe("/env/artifacts");
      expect(config.org).toBe("env-org");
    });
  });
});
