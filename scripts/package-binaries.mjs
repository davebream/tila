import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function packageBinaries(
  directory,
  cliRoot,
  bunVersion,
  epoch = 0,
) {
  if (!bunVersion || !/^\d+\.\d+\.\d+/.test(bunVersion))
    throw new Error("BUN_VERSION must identify the compiler runtime");
  const binaries = (await readdir(directory))
    .filter((name) =>
      /^tila-(darwin|linux|windows)-[\w-]+(?:\.exe)?$/.test(name),
    )
    .sort();
  if (binaries.length !== 8)
    throw new Error(
      `Expected eight release binaries, found ${binaries.length}`,
    );
  const checksums = [];
  for (const name of binaries) {
    const bytes = await readFile(join(directory, name));
    const compressed = gzipSync(bytes, { level: 9 });
    await writeFile(join(directory, `${name}.gz`), compressed);
    checksums.push(
      `${sha256(bytes)}  ${name}`,
      `${sha256(compressed)}  ${name}.gz`,
    );
    const metadata = JSON.parse(
      await readFile(join(cliRoot, "dist", "metadata", `${name}.json`), "utf8"),
    );
    const dependencies = new Map();
    // The Worker sidecar is embedded as text, so include its original esbuild inputs too.
    const worker = JSON.parse(
      await readFile(join(cliRoot, "worker/bundle-meta.json"), "utf8"),
    );
    const workerInputs = Object.keys(worker.inputs).map((input) =>
      resolve(cliRoot, "../worker", input),
    );
    for (const input of [...Object.keys(metadata.inputs), ...workerInputs]) {
      if (input.startsWith("bun:") || input.startsWith("node:")) continue;
      let cursor = dirname(resolve(cliRoot, input));
      while (cursor !== dirname(cursor)) {
        try {
          const pkg = JSON.parse(
            await readFile(join(cursor, "package.json"), "utf8"),
          );
          if (pkg.name && pkg.version) {
            dependencies.set(`${pkg.name}@${pkg.version}`, pkg);
            break;
          }
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        cursor = dirname(cursor);
      }
    }
    dependencies.set(`bun@${bunVersion}`, {
      name: "bun",
      version: bunVersion,
      license: "MIT",
    });
    const packages = [...dependencies.values()]
      .sort((a, b) =>
        `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
      )
      .map((pkg, i) => ({
        SPDXID: `SPDXRef-Package-${i}`,
        name: pkg.name,
        versionInfo: pkg.version,
        downloadLocation: "NOASSERTION",
        filesAnalyzed: false,
        licenseConcluded: "NOASSERTION",
        licenseDeclared:
          typeof pkg.license === "string" ? pkg.license : "NOASSERTION",
        copyrightText: "NOASSERTION",
      }));
    const document = {
      spdxVersion: "SPDX-2.3",
      dataLicense: "CC0-1.0",
      SPDXID: "SPDXRef-DOCUMENT",
      name,
      documentNamespace: `https://github.com/davebream/tila/sbom/${name}/${sha256(bytes)}`,
      creationInfo: {
        creators: ["Tool: tila-release-packager"],
        created: new Date(Number(epoch) * 1000)
          .toISOString()
          .replace(/\.\d{3}Z$/, "Z"),
      },
      documentDescribes: ["SPDXRef-Binary"],
      packages: [
        {
          SPDXID: "SPDXRef-Binary",
          name,
          downloadLocation: "NOASSERTION",
          filesAnalyzed: false,
          checksums: [{ algorithm: "SHA256", checksumValue: sha256(bytes) }],
          licenseConcluded: "NOASSERTION",
          licenseDeclared: "MIT",
          copyrightText: "NOASSERTION",
        },
        ...packages,
      ],
      relationships: packages.map((pkg) => ({
        spdxElementId: "SPDXRef-Binary",
        relationshipType: "CONTAINS",
        relatedSpdxElement: pkg.SPDXID,
      })),
    };
    await writeFile(
      join(directory, `${name}.spdx.json`),
      `${JSON.stringify(document, null, 2)}\n`,
    );
  }
  await writeFile(
    join(directory, "checksums.txt"),
    `${checksums.join("\n")}\n`,
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await packageBinaries(
    resolve("packages/cli/dist/binaries"),
    resolve("packages/cli"),
    process.env.BUN_VERSION,
    process.env.SOURCE_DATE_EPOCH,
  );
}
