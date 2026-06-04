/**
 * Compare two semver strings numerically by major.minor.patch components.
 *
 * Pre-release tags (e.g., "-alpha.1") are NOT handled in v0.1 — they are
 * stripped and the numeric components are compared only. This is intentional
 * for the CLI version-check use case which uses plain release semver.
 *
 * @returns -1 if a < b, 0 if a === b, 1 if a > b
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const parse = (v: string): [number, number, number] => {
    // Strip pre-release / build metadata tags
    const core = v.split(/[-+]/)[0];
    const parts = (core ?? "").split(".");
    const major = Number.parseInt(parts[0] ?? "0", 10);
    const minor = Number.parseInt(parts[1] ?? "0", 10);
    const patch = Number.parseInt(parts[2] ?? "0", 10);
    return [
      Number.isNaN(major) ? 0 : major,
      Number.isNaN(minor) ? 0 : minor,
      Number.isNaN(patch) ? 0 : patch,
    ];
  };

  const [aMaj, aMin, aPat] = parse(a);
  const [bMaj, bMin, bPat] = parse(b);

  if (aMaj !== bMaj) return aMaj < bMaj ? -1 : 1;
  if (aMin !== bMin) return aMin < bMin ? -1 : 1;
  if (aPat !== bPat) return aPat < bPat ? -1 : 1;
  return 0;
}
