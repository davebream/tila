import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  INFRA_DIR_NAME,
  getInfraSlug,
  loadInfraConfig,
  writeInfraConfig,
} from "../../lib/infra-config";

describe("infra-config", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `tila-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe("writeInfraConfig", () => {
    it("creates directory with mode 0o700", () => {
      const tilaDir = join(testDir, INFRA_DIR_NAME);
      writeInfraConfig(
        { account_id: "abc", account_name: "Test", d1_database_id: "d1-uuid" },
        tilaDir,
      );
      expect(existsSync(tilaDir)).toBe(true);
      expect(statSync(tilaDir).mode & 0o777).toBe(0o700);
    });

    it("writes valid TOML that roundtrips through loadInfraConfig", () => {
      const tilaDir = join(testDir, INFRA_DIR_NAME);
      const config = {
        account_id: "abc",
        account_name: "Test Corp",
        d1_database_id: "d1-uuid",
        github_app: { app_id: 123, installation_id: 456 },
      };
      writeInfraConfig(config, tilaDir);
      const loaded = loadInfraConfig(tilaDir);
      expect(loaded).toEqual(config);
    });

    it("writes infra.toml without github_app when not provided", () => {
      const tilaDir = join(testDir, INFRA_DIR_NAME);
      writeInfraConfig(
        { account_id: "abc", account_name: "Test", d1_database_id: "d1-uuid" },
        tilaDir,
      );
      const loaded = loadInfraConfig(tilaDir);
      expect(loaded.github_app).toBeUndefined();
    });
  });

  describe("backward compatibility", () => {
    it("parses config without new optional fields", () => {
      const tilaDir = join(testDir, INFRA_DIR_NAME);
      const config = {
        account_id: "abc",
        account_name: "Test",
        d1_database_id: "d1-uuid",
      };
      writeInfraConfig(config, tilaDir);
      const loaded = loadInfraConfig(tilaDir);
      expect(loaded.account_id).toBe("abc");
      expect(loaded.worker_url).toBeUndefined();
      expect(loaded.r2_bucket_name).toBeUndefined();
      expect(loaded.hmac_key).toBeUndefined();
      expect(loaded.sweep_secret).toBeUndefined();
    });

    it("parses config with all new optional fields", () => {
      const tilaDir = join(testDir, INFRA_DIR_NAME);
      const config = {
        account_id: "abc",
        account_name: "Test",
        d1_database_id: "d1-uuid",
        worker_url: "https://tila.example.com",
        r2_bucket_name: "tila-artifacts",
        hmac_key: "secret-hmac-key-123",
        sweep_secret: "sweep-secret-456",
      };
      writeInfraConfig(config, tilaDir);
      const loaded = loadInfraConfig(tilaDir);
      expect(loaded).toEqual(config);
    });
  });

  describe("infra_slug field", () => {
    it("parses config without infra_slug (backward compat)", () => {
      const tilaDir = join(testDir, INFRA_DIR_NAME);
      const config = {
        account_id: "abc",
        account_name: "Test",
        d1_database_id: "d1-uuid",
      };
      writeInfraConfig(config, tilaDir);
      const loaded = loadInfraConfig(tilaDir);
      expect(loaded.infra_slug).toBeUndefined();
    });

    it("parses config with infra_slug and round-trips through TOML", () => {
      const tilaDir = join(testDir, INFRA_DIR_NAME);
      const config = {
        account_id: "abc",
        account_name: "Test",
        d1_database_id: "d1-uuid",
        infra_slug: "my-app",
      };
      writeInfraConfig(config, tilaDir);
      const loaded = loadInfraConfig(tilaDir);
      expect(loaded.infra_slug).toBe("my-app");
    });
  });

  describe("getInfraSlug", () => {
    it("returns 'tila' when infra_slug is absent", () => {
      const config = {
        account_id: "abc",
        account_name: "Test",
        d1_database_id: "d1-uuid",
      };
      expect(getInfraSlug(config)).toBe("tila");
    });

    it("returns the slug when infra_slug is set", () => {
      const config = {
        account_id: "abc",
        account_name: "Test",
        d1_database_id: "d1-uuid",
        infra_slug: "my-app",
      };
      expect(getInfraSlug(config)).toBe("my-app");
    });
  });

  describe("loadInfraConfig", () => {
    it("throws when infra.toml is missing", () => {
      expect(() => loadInfraConfig(join(testDir, ".tila"))).toThrow(
        /infra\.toml/,
      );
    });

    it("throws on invalid TOML content", () => {
      const tilaDir = join(testDir, INFRA_DIR_NAME);
      mkdirSync(tilaDir, { recursive: true });
      const { writeFileSync } = require("node:fs");
      writeFileSync(join(tilaDir, "infra.toml"), "not valid toml [[[");
      expect(() => loadInfraConfig(tilaDir)).toThrow();
    });

    it("throws on schema validation failure", () => {
      const tilaDir = join(testDir, INFRA_DIR_NAME);
      mkdirSync(tilaDir, { recursive: true });
      const { writeFileSync } = require("node:fs");
      writeFileSync(join(tilaDir, "infra.toml"), 'account_id = "abc"\n');
      expect(() => loadInfraConfig(tilaDir)).toThrow(/account_name/);
    });
  });
});
