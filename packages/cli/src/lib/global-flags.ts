/**
 * Global pre-dispatch flag parser and singleton for CLI.
 *
 * Citty 0.2.2 has NO arg inheritance — a root-declared flag never reaches
 * subcommand `run` contexts. Therefore --instance/--token/--project are parsed
 * pre-dispatch from process.argv into a module-level singleton (GlobalFlags).
 * Commands that resolve an instance read them via getGlobalFlags().
 *
 * Spread `globalFlagArgs` into each leaf command's `args` so citty parses them
 * as flags (not positionals) and --help documents them correctly.
 */

/** The three pre-dispatch global flags. */
export interface GlobalFlags {
  instance?: string;
  token?: string;
  project?: string;
}

/** Module-level singleton. Populated once at startup by index.ts. */
let _flags: GlobalFlags = {};

/**
 * Parse --instance/--token/--project from an argv array (space or = forms,
 * any position). Does NOT strip them from the array — citty also sees them.
 */
export function parseGlobalFlags(argv: string[]): GlobalFlags {
  const flags: GlobalFlags = {};
  const keys = ["instance", "token", "project"] as const;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    for (const key of keys) {
      const prefix = `--${key}=`;
      if (arg.startsWith(prefix)) {
        flags[key] = arg.slice(prefix.length);
        break;
      }
      if (arg === `--${key}` && i + 1 < argv.length) {
        // Only consume as flag value if next arg doesn't look like a flag
        const next = argv[i + 1];
        if (!next.startsWith("-")) {
          flags[key] = next;
          i++; // skip the value
        }
        break;
      }
    }
  }

  return flags;
}

/** Return the current global flags singleton. */
export function getGlobalFlags(): GlobalFlags {
  return _flags;
}

/** Set the global flags singleton. Called once in index.ts before runMain. */
export function setGlobalFlags(flags: GlobalFlags): void {
  _flags = flags;
}

/** Reset the singleton to empty (for test isolation — call in beforeEach). */
export function resetGlobalFlags(): void {
  _flags = {};
}

/**
 * Shared global-flag args declaration for leaf commands.
 *
 * Spread into each command's `args` so citty parses --instance/--token/--project
 * as named flags (not positionals) and --help documents them.
 *
 * The actual values are consumed via getGlobalFlags() from the pre-dispatch
 * singleton — the per-command parsed value is not used for resolution.
 */
export const globalFlagArgs = {
  instance: {
    type: "string" as const,
    description: "Override the active instance key",
  },
  token: {
    type: "string" as const,
    description: "Use an inline bearer token (bypass keychain)",
  },
  project: {
    type: "string" as const,
    description: "Assert or select a project (maps to worker_url)",
  },
} as const;
