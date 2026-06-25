import os from "node:os";
import path from "node:path";

/**
 * Valid segment kinds:
 * - "slug": infra slug, charset ^[a-z0-9][a-z0-9_-]{0,63}$ (max 64 chars total)
 * - "key":  instance key, charset ^[A-Za-z0-9._:-]{1,128}$
 *
 * In both cases a path.resolve containment check is also applied when the
 * segment is used to build a filesystem path — see TilaPaths.infraFile().
 */
export type SegmentKind = "slug" | "key";

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Validate a value that will be used as a filename segment or keychain account.
 *
 * Layer 1: charset whitelist.
 * Layer 2: (applied separately in TilaPaths.infraFile) path.resolve containment.
 *
 * Throws if the value fails the charset check.
 */
export function safeSegment(value: string, kind: SegmentKind): void {
  if (kind === "slug") {
    if (!SLUG_RE.test(value)) {
      throw new Error(
        `Invalid slug segment ${JSON.stringify(value)}: must match ^[a-z0-9][a-z0-9_-]{0,63}$`,
      );
    }
  } else {
    if (!KEY_RE.test(value)) {
      throw new Error(
        `Invalid key segment ${JSON.stringify(value)}: must match ^[A-Za-z0-9._:-]{1,128}$`,
      );
    }
  }
}

/**
 * Resolves and exposes the tila home directory layout.
 *
 * Resolution order:
 * 1. TILA_HOME env var (allows CI/automation to override the default location)
 * 2. ~/.tila (OS home directory fallback)
 *
 * Mirrors packages/cli/src/lib/provisioning.ts tilaHome().
 */
export class TilaPaths {
  readonly home: string;
  /** True when TILA_HOME was set to a non-empty value — consumed by J2's CI fail-closed. */
  readonly homeOverridden: boolean;

  constructor() {
    const envHome = process.env.TILA_HOME;
    if (envHome) {
      this.home = envHome;
      this.homeOverridden = true;
    } else {
      this.home = path.join(os.homedir(), ".tila");
      this.homeOverridden = false;
    }
  }

  /** Path to ~/.tila/instances.toml */
  registryFile(): string {
    return path.join(this.home, "instances.toml");
  }

  /** Path to ~/.tila/infra/ directory */
  infraDir(): string {
    return path.join(this.home, "infra");
  }

  /**
   * Path to ~/.tila/infra/<slug>.toml.
   *
   * Applies a two-layer path-traversal guard:
   * Layer 1: charset check via safeSegment.
   * Layer 2: path.resolve containment — resolved path must start with
   *          <home>/infra/ (mirrors bun-blob-store.ts:21-34 resolve-then-startsWith).
   *
   * Throws on any invalid slug.
   */
  infraFile(slug: string): string {
    // Layer 1: charset check
    safeSegment(slug, "slug");

    const full = path.join(this.infraDir(), `${slug}.toml`);

    // Layer 2: containment check
    const root = path.resolve(this.infraDir());
    const resolved = path.resolve(full);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error(
        `Infra slug escapes the infra directory: ${JSON.stringify(slug)}`,
      );
    }

    return full;
  }
}
