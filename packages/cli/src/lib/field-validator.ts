import { TILA_ERRORS } from "tila-sdk";
import { printJsonError } from "./output";

/**
 * Parse a `--field` argument as `key=value`.
 *
 * Requires exactly one `=` separator; the key may not be empty.
 * The value may contain additional `=` characters (split on the first `=`).
 *
 * Throws a coded error object (matching describeCliError shape) when the
 * format is invalid. Callers that handle `--json` should catch and route
 * through `failWithCliError(err, json)`.
 *
 * @example
 * validateField("status=open")      // { key: "status", value: "open" }
 * validateField("name=foo=bar")     // { key: "name", value: "foo=bar" }
 * validateField("foobar")           // throws (no = separator)
 * validateField("=value")           // throws (empty key)
 */
export function validateField(raw: string): { key: string; value: string } {
  const eqIdx = raw.indexOf("=");
  if (eqIdx === -1) {
    const err = Object.assign(
      new Error(
        `Invalid --field value "${raw}": expected key=value format (missing "="). Example: --field status=open`,
      ),
      {
        name: "TilaApiError",
        code: TILA_ERRORS.VALIDATION_ERROR_DO,
      },
    );
    throw err;
  }
  const key = raw.slice(0, eqIdx);
  const value = raw.slice(eqIdx + 1);
  if (!key) {
    const err = Object.assign(
      new Error(
        `Invalid --field value "${raw}": key must not be empty. Example: --field status=open`,
      ),
      {
        name: "TilaApiError",
        code: TILA_ERRORS.VALIDATION_ERROR_DO,
      },
    );
    throw err;
  }
  return { key, value };
}

/**
 * Parse `--field` and fail loudly in `--json` mode with a CliErrorEnvelope,
 * or print to stderr and exit 1 in plain mode.
 *
 * Returns the parsed { key, value } pair on success.
 */
export function parseFieldArg(
  raw: string,
  json: boolean,
): { key: string; value: string } {
  try {
    return validateField(raw);
  } catch (err) {
    if (json) {
      const e = err as { code?: string; message?: string };
      printJsonError(
        e.message ?? String(err),
        e.code ?? TILA_ERRORS.VALIDATION_ERROR_DO,
        "Use key=value format, e.g. --field status=open",
        1,
      );
    }
    console.error((err as Error).message);
    process.exit(1);
  }
}
