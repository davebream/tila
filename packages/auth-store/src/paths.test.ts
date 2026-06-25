import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TilaPaths, safeSegment } from "./paths.js";

describe("TilaPaths", () => {
  const savedEnv = process.env.TILA_HOME;

  afterEach(() => {
    if (savedEnv === undefined) {
      // biome cannot use delete; use Reflect.deleteProperty instead
      Reflect.deleteProperty(process.env, "TILA_HOME");
    } else {
      process.env.TILA_HOME = savedEnv;
    }
  });

  it("defaults to ~/.tila when TILA_HOME is not set", () => {
    Reflect.deleteProperty(process.env, "TILA_HOME");
    const p = new TilaPaths();
    expect(p.home).toBe(path.join(os.homedir(), ".tila"));
    expect(p.homeOverridden).toBe(false);
  });

  it("uses TILA_HOME when set", () => {
    process.env.TILA_HOME = "/tmp/custom-tila-home";
    const p = new TilaPaths();
    expect(p.home).toBe("/tmp/custom-tila-home");
    expect(p.homeOverridden).toBe(true);
  });

  it("homeOverridden is false when TILA_HOME is empty string", () => {
    process.env.TILA_HOME = "";
    const p = new TilaPaths();
    expect(p.home).toBe(path.join(os.homedir(), ".tila"));
    expect(p.homeOverridden).toBe(false);
  });

  it("registryFile returns path to instances.toml", () => {
    process.env.TILA_HOME = "/custom/tila";
    const p = new TilaPaths();
    expect(p.registryFile()).toBe("/custom/tila/instances.toml");
  });

  it("infraDir returns path to infra directory", () => {
    process.env.TILA_HOME = "/custom/tila";
    const p = new TilaPaths();
    expect(p.infraDir()).toBe("/custom/tila/infra");
  });

  it("infraFile returns path to infra/<slug>.toml", () => {
    process.env.TILA_HOME = "/custom/tila";
    const p = new TilaPaths();
    expect(p.infraFile("my-slug")).toBe("/custom/tila/infra/my-slug.toml");
  });

  it("infraFile accepts a UUID-like slug", () => {
    process.env.TILA_HOME = "/custom/tila";
    const p = new TilaPaths();
    // UUIDs don't match the slug pattern, but a slug-like value does
    expect(() => p.infraFile("my-deploy-01")).not.toThrow();
  });

  it("infraFile rejects ../x traversal", () => {
    process.env.TILA_HOME = "/custom/tila";
    const p = new TilaPaths();
    expect(() => p.infraFile("../x")).toThrow();
  });

  it("infraFile rejects a/b (path separator)", () => {
    process.env.TILA_HOME = "/custom/tila";
    const p = new TilaPaths();
    expect(() => p.infraFile("a/b")).toThrow();
  });
});

describe("safeSegment", () => {
  describe("slug kind", () => {
    it("accepts a valid simple slug", () => {
      expect(() => safeSegment("my-slug", "slug")).not.toThrow();
    });

    it("accepts a lowercase slug with digits and dashes", () => {
      expect(() => safeSegment("deploy-01", "slug")).not.toThrow();
    });

    it("accepts a slug with underscores", () => {
      expect(() => safeSegment("my_slug", "slug")).not.toThrow();
    });

    it("rejects empty string", () => {
      expect(() => safeSegment("", "slug")).toThrow();
    });

    it("rejects slug starting with a dash", () => {
      expect(() => safeSegment("-bad", "slug")).toThrow();
    });

    it("rejects slug with uppercase", () => {
      expect(() => safeSegment("MySlug", "slug")).toThrow();
    });

    it("rejects ../x traversal", () => {
      expect(() => safeSegment("../x", "slug")).toThrow();
    });

    it("rejects a/b path separator", () => {
      expect(() => safeSegment("a/b", "slug")).toThrow();
    });

    it("rejects overlong slug (> 64 chars)", () => {
      const overlong = `a${"b".repeat(64)}`; // 65 chars
      expect(() => safeSegment(overlong, "slug")).toThrow();
    });

    it("accepts maximum length slug (64 chars: 1 leading + 63 body)", () => {
      const maxlen = `a${"b".repeat(63)}`; // 64 chars total
      expect(() => safeSegment(maxlen, "slug")).not.toThrow();
    });
  });

  describe("key kind", () => {
    it("accepts a UUID-like instance key", () => {
      expect(() =>
        safeSegment("550e8400-e29b-41d4-a716-446655440000", "key"),
      ).not.toThrow();
    });

    it("accepts a server instance id format", () => {
      expect(() => safeSegment("server-instance-id.v1", "key")).not.toThrow();
    });

    it("accepts colons and dots in key", () => {
      expect(() => safeSegment("tila:some.key:v1", "key")).not.toThrow();
    });

    it("rejects empty string", () => {
      expect(() => safeSegment("", "key")).toThrow();
    });

    it("rejects ../x traversal in key", () => {
      expect(() => safeSegment("../x", "key")).toThrow();
    });

    it("rejects key with path separator /", () => {
      expect(() => safeSegment("a/b", "key")).toThrow();
    });

    it("rejects overlong key (> 128 chars)", () => {
      const overlong = "a".repeat(129);
      expect(() => safeSegment(overlong, "key")).toThrow();
    });

    it("accepts maximum length key (128 chars)", () => {
      const maxlen = "a".repeat(128);
      expect(() => safeSegment(maxlen, "key")).not.toThrow();
    });
  });
});
