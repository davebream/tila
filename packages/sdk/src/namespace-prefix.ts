/**
 * Pure prefix/strip primitives for the namespace coexistence convention.
 * No I/O — shared by all four resource adapters in namespace.ts.
 */

/**
 * Validates that a namespace string matches /^[a-z][a-z0-9_-]*$/.
 * Throws TypeError for empty strings or strings containing invalid characters.
 */
export function validateNamespace(ns: string): void {
  if (!/^[a-z][a-z0-9_-]*$/.test(ns)) {
    throw new TypeError(
      `Invalid namespace "${ns}": must match /^[a-z][a-z0-9_-]*$/ (lowercase letter start, then lowercase letters, digits, underscores, or hyphens).`,
    );
  }
}

/**
 * Returns "${ns}_${name}".
 * Throws a plain Error (not TilaApiError) if the name already starts with "${ns}_".
 */
export function applyPrefix(ns: string, name: string): string {
  if (name.startsWith(`${ns}_`)) {
    throw new Error(
      `Namespace collision: "${name}" already starts with prefix "${ns}_". Call the raw factory if this name is intentional.`,
    );
  }
  return `${ns}_${name}`;
}

/**
 * Returns the name with a leading "${ns}_" removed if present; otherwise returns name unchanged.
 * Never throws — tolerant strip for mixed-namespace lists.
 */
export function stripPrefix(ns: string, name: string): string {
  const prefix = `${ns}_`;
  if (name.startsWith(prefix)) {
    return name.slice(prefix.length);
  }
  return name;
}
