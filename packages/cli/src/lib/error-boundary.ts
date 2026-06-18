import type { CommandDef } from "citty";
import { failWithCliError } from "./output";
// EXIT_CODES, ExitCode, exitCodeFor are in a separate module to avoid circular deps.
// error-boundary → output (for failWithCliError)
// output → exit-codes (for exitCodeFor — no circular dep)
// error-boundary → exit-codes (re-exported here for callers)
export { EXIT_CODES, exitCodeFor } from "./exit-codes";
export type { ExitCode } from "./exit-codes";

// citty's CommandDef generic is invariant (run is contravariant in its args),
// so a specifically-typed command is not assignable to CommandDef<ArgsDef> and
// subcommand trees are heterogeneous; a loose alias lets us wrap any command.
// biome-ignore lint/suspicious/noExplicitAny: see note above
type AnyCommand = CommandDef<any>;

/**
 * Wrap a command — and, recursively, its plain-object subcommands — so any
 * error thrown by a `run` handler is rendered as a clean one-line CLI error
 * (structured JSON under `--json`) instead of leaking a bundled stack trace
 * through citty's top-level handler, which dumps the full error object.
 *
 * This is the global backstop for every fence-bearing/destructive command
 * (`record set/put/patch`, `gate resolve`, `artifact write`, ...). Commands
 * that already handle their own errors and re-throw only unknown ones still
 * benefit: the re-thrown error is caught here and rendered cleanly.
 *
 * Lazy (function) subcommand loaders are left untouched — citty resolves them
 * at call time; the loader in `index.ts` applies the boundary to each
 * top-level command module, whose own subcommands are plain objects.
 */
export function withErrorBoundary(cmd: AnyCommand): AnyCommand {
  const wrapped = { ...cmd };

  if (typeof cmd.run === "function") {
    const original = cmd.run.bind(cmd);
    wrapped.run = async (
      ctx: Parameters<NonNullable<AnyCommand["run"]>>[0],
    ) => {
      try {
        return await original(ctx);
      } catch (err) {
        const args = ctx.args as { json?: boolean } | undefined;
        failWithCliError(err, Boolean(args?.json));
      }
    };
  }

  const subs = cmd.subCommands;
  if (subs && typeof subs === "object" && !(subs instanceof Promise)) {
    const next: Record<string, unknown> = {};
    for (const [name, sub] of Object.entries(subs)) {
      next[name] =
        typeof sub === "function" || sub instanceof Promise
          ? sub
          : withErrorBoundary(sub as AnyCommand);
    }
    wrapped.subCommands = next as CommandDef["subCommands"];
  }

  return wrapped;
}
