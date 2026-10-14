import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checks, sanitize, verifyArtifacts } from "./issue-308-scenarios.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const publicBytes = (bytes, base) => {
  let data;
  try {
    data = JSON.parse(bytes);
  } catch {
    return Buffer.from(sanitize(bytes.toString(), base));
  }
  return Buffer.from(
    `${JSON.stringify(data, (_key, value) => (typeof value === "string" ? sanitize(value, base) : value), 2)}\n`,
  );
};

/** Publish sanitized copies; source manifests, ledgers and artifacts are read-only. */
export function publishReports({
  reportPaths,
  base = root,
  expectedChecks = checks,
}) {
  const sources = reportPaths.map((path) => {
    const bytes = readFileSync(resolve(base, path));
    const report = JSON.parse(bytes);
    verifyArtifacts(report, base);
    return { path, bytes, report };
  });
  const green = sources.findLast(({ report }) =>
    expectedChecks.every((check) =>
      report.observations.some(
        (o) => o.step === check.step && o.result === "passed",
      ),
    ),
  );
  assert.ok(
    green,
    "Complete green local driver evidence required before publication",
  );
  const publication = {
    schema_version: 1,
    issue: 308,
    scope:
      "Bounded protocol/local fixtures; integrated S1 and authenticated S2/S3 remain unexecuted",
    recorded_at: new Date().toISOString(),
    publication:
      "Historical local ledgers and artifacts remain immutable. Every publication copy is sanitized: source_artifact_sha256 refers to the local original, sha256 to public bytes. Source manifest checksums still refer to local originals; publication observation refs below identify sanitized copies. Historical timestamps, results and reasons are preserved.",
    retained_reports: [],
    observations: [],
    final_green: null,
  };
  for (const source of sources) {
    const directory = `docs/evidence/issue-308-local/${basename(dirname(source.path))}`;
    mkdirSync(resolve(base, directory), { recursive: true });
    const copy = (path, bytes) => {
      const sanitized = publicBytes(bytes, base);
      // Publication copies may be regenerated; the source paths are never written.
      writeFileSync(resolve(base, path), sanitized);
      return {
        path,
        sha256: hash(sanitized),
        source_artifact_sha256: hash(bytes),
      };
    };
    const manifestRef = copy(`${directory}/original-report.log`, source.bytes);
    publication.retained_reports.push(manifestRef);
    for (const observation of source.report.observations) {
      const refs = observation.artifact_refs.map((ref) => {
        const suffix = ref.path.endsWith(".json") ? ".log" : "";
        return copy(
          `${directory}/${basename(ref.path)}${suffix}`,
          readFileSync(resolve(base, ref.path)),
        );
      });
      publication.observations.push({
        ...observation,
        artifact_refs: [...refs, manifestRef],
      });
    }
    if (source === green)
      publication.final_green = {
        candidate_sha: source.report.candidate_sha,
        source_sha256: source.report.source_sha256,
        report_ref: manifestRef,
        passed_local_checks: expectedChecks.length,
        blocked_journeys: source.report.observations.filter(
          (o) => o.result === "blocked",
        ).length,
      };
    assert.equal(
      hash(readFileSync(resolve(base, source.path))),
      hash(source.bytes),
      "Source manifest changed during publication",
    );
    verifyArtifacts(source.report, base);
  }
  verifyArtifacts(publication, base);
  writeFileSync(
    resolve(base, "docs/evidence/issue-308-local-v1.json"),
    `${JSON.stringify(publication, null, 2)}\n`,
  );
  return publication;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const paths = process.argv.slice(2);
  assert.ok(paths.length > 0, "Provide retained local report paths");
  for (const path of paths)
    assert.match(
      path,
      /^\.ci-reports\/issue-308(?:-preflight|-privacy)?\/(?:[^/]+\/)?report\.json$/,
    );
  const publication = publishReports({ reportPaths: paths });
  console.log(
    `Published ${publication.retained_reports.length} sanitized reports, ${publication.observations.length} observations; local originals unchanged`,
  );
}
