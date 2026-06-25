/**
 * legacy-reader.ts — read legacy .tila/.env / .tila/.session / flat infra.toml (WI-M / C1)
 *
 * Pure file I/O. No Cloudflare imports. No process.env reads.
 * Dependency-injected via LegacyLocations.
 *
 * F-B fix (CRITICAL): .session expires_at is Unix SECONDS in the file, but
 * CredentialRecord/AuthStore use MILLISECONDS. This module normalizes to ms.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type TilaInfraConfig, TilaInfraConfigSchema } from "@tila/schemas";
import { parse } from "smol-toml";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Injected filesystem paths for legacy credential discovery. */
export interface LegacyLocations {
  /** The walked-up .tila directory for the current project. null when outside a repo. */
  projectTilaDir: string | null;
  /** Path to ~/.tila/infra.toml (flat single-slot legacy). null when absent. */
  homeInfraToml: string | null;
}

/** A legacy credential read from .tila/.env or .tila/.session. */
export interface LegacyCredential {
  /** Raw bearer token from .tila/.env (TILA_API_TOKEN) or .tila/.session. */
  token: string;
  kind: "tila-token" | "github-session";
  /**
   * Epoch MILLISECONDS; null for .env tokens (no expiry).
   * F-B fix: .session stores seconds — normalized here to ms.
   */
  expires_at: number | null;
  /** Source path for the migration report / trace detail (never the token). */
  source_path: string;
  /** true when the source file is more permissive than 0o600. */
  insecure_mode: boolean;
}

/** A legacy infra blob read from .tila/infra.toml or the flat ~/.tila/infra.toml. */
export interface LegacyInfraBlob {
  /** getInfraSlug(config) for project; always "tila" for the flat home file. */
  slug: string;
  /** Composite config (meta + secret fields), validated against TilaInfraConfigSchema. */
  config: TilaInfraConfig;
  source_path: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Returns true if the file at path has world- or group-readable bits. */
function isInsecureMode(filePath: string): boolean {
  try {
    const mode = statSync(filePath).mode;
    return (mode & 0o077) !== 0;
  } catch {
    return false;
  }
}

/** Parse .env-format content and return the value for TILA_API_TOKEN, or null. */
function parseDotEnv(content: string): string | null {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || trimmed.length === 0) {
      continue;
    }
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    // Strip optional surrounding single or double quotes
    const unquoted = value.replace(/^["']|["']$/g, "");
    if (key === "TILA_API_TOKEN" && unquoted.length > 0) {
      return unquoted;
    }
  }
  return null;
}

/** Returns infra_slug ?? "tila" from a TilaInfraConfig. */
function getInfraSlug(config: TilaInfraConfig): string {
  return config.infra_slug ?? "tila";
}

/**
 * Parse and validate an infra.toml file.
 * Throws a descriptive Error on corrupt TOML or invalid schema.
 */
function parseInfraToml(filePath: string): TilaInfraConfig {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new Error(`Failed to read infra.toml at ${filePath}: ${err}`);
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse TOML at ${filePath}: ${err}`);
  }

  const result = TilaInfraConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Invalid infra.toml at ${filePath}: ${result.error.message}`,
    );
  }

  return result.data;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read the best available legacy credential from the injected paths.
 *
 * Priority: .tila/.env (TILA_API_TOKEN) first, then .tila/.session.
 *
 * - Absence → null.
 * - Expired .session → null (treated as no usable token).
 * - Corrupt .session JSON → THROWS (never silently drops data).
 * - No process.env reads — that is the resolver env rung's responsibility.
 */
export function readLegacyCredential(
  loc: LegacyLocations,
): LegacyCredential | null {
  const tilaDir = loc.projectTilaDir;
  if (!tilaDir) return null;

  // Try .tila/.env first
  const envPath = join(tilaDir, ".env");
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, "utf-8");
    const token = parseDotEnv(content);
    if (token) {
      return {
        token,
        kind: "tila-token",
        expires_at: null, // .env tokens have no expiry
        source_path: envPath,
        insecure_mode: isInsecureMode(envPath),
      };
    }
  }

  // Try .tila/.session
  const sessionPath = join(tilaDir, ".session");
  if (existsSync(sessionPath)) {
    const content = readFileSync(sessionPath, "utf-8");

    // Corruption throws — not silently dropped
    let parsed: { session_token: string; expires_at: number };
    try {
      parsed = JSON.parse(content) as {
        session_token: string;
        expires_at: number;
      };
    } catch (err) {
      throw new Error(
        `Corrupt .tila/.session at ${sessionPath}: JSON parse failed — ${err}`,
      );
    }

    if (
      typeof parsed.session_token !== "string" ||
      typeof parsed.expires_at !== "number"
    ) {
      throw new Error(
        `Corrupt .tila/.session at ${sessionPath}: missing session_token or expires_at fields`,
      );
    }

    // F-B fix: file stores Unix SECONDS; normalize to MILLISECONDS
    const expiresAtMs = parsed.expires_at * 1000;

    // Expired sessions are treated as no usable token
    if (expiresAtMs < Date.now()) {
      return null;
    }

    return {
      token: parsed.session_token,
      kind: "github-session",
      expires_at: expiresAtMs, // normalized to ms
      source_path: sessionPath,
      insecure_mode: isInsecureMode(sessionPath),
    };
  }

  return null;
}

/**
 * Read all available legacy infra blobs from the injected paths.
 *
 * - Project .tila/infra.toml: slug from getInfraSlug (infra_slug ?? "tila").
 * - Flat home ~/.tila/infra.toml: always slug "tila" (single-slot convention).
 * - Absence → [] (empty array).
 * - Corrupt TOML / invalid schema → THROWS.
 */
export function readLegacyInfraBlobs(loc: LegacyLocations): LegacyInfraBlob[] {
  const blobs: LegacyInfraBlob[] = [];

  // Project .tila/infra.toml
  if (loc.projectTilaDir) {
    const projectInfraPath = join(loc.projectTilaDir, "infra.toml");
    if (existsSync(projectInfraPath)) {
      const config = parseInfraToml(projectInfraPath);
      blobs.push({
        slug: getInfraSlug(config),
        config,
        source_path: projectInfraPath,
      });
    }
  }

  // Flat home ~/.tila/infra.toml — always slug "tila" (single-slot legacy)
  if (loc.homeInfraToml && existsSync(loc.homeInfraToml)) {
    const config = parseInfraToml(loc.homeInfraToml);
    blobs.push({
      slug: "tila", // flat home infra always maps to slug "tila"
      config,
      source_path: loc.homeInfraToml,
    });
  }

  return blobs;
}
