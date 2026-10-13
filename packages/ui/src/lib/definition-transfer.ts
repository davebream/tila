import {
  type DefinitionExportInput,
  type DefinitionFormat,
  type ReadDefinitionResult,
  type RenderedDefinitionExport,
  definitionFormatFromName,
  readTomlDefinition,
  renderTomlDefinitionExport,
} from "@tila/core";
import { DEFINITION_MAX_BYTES } from "@tila/schemas";

/**
 * Browser side of definition import and export. TOML is handled by the main
 * bundle; YAML loads `@tila/core/definition-yaml` (and the yaml library) on
 * first use, so pages that never touch YAML don't download it.
 */

const loadYaml = () => import("@tila/core/definition-yaml");

export type ImportFormat = DefinitionFormat | "auto";

/** Read import text (from a file or pasted) into a definition document. */
export async function readDefinitionInput(
  text: string,
  options: { format: ImportFormat; filename?: string },
): Promise<ReadDefinitionResult> {
  let format = options.format;
  if (format === "auto" && options.filename) {
    const named = definitionFormatFromName(options.filename);
    if (typeof named !== "string") return { ok: false, errors: [named] };
    format = named;
  }
  if (format === "toml") return readTomlDefinition(text);
  const { readDefinitionFile } = await loadYaml();
  return readDefinitionFile(text, { format });
}

/** File text, refusing oversize files before reading them. */
export async function readDefinitionFileText(
  file: File,
): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
  if (file.size > DEFINITION_MAX_BYTES)
    return {
      ok: false,
      message: `${file.name} is ${Math.ceil(file.size / 1024)} KiB; definitions are limited to ${DEFINITION_MAX_BYTES / 1024} KiB.`,
    };
  return { ok: true, text: await file.text() };
}

export async function renderDefinitionExportText(
  input: DefinitionExportInput,
  format: DefinitionFormat,
): Promise<RenderedDefinitionExport> {
  if (format === "toml") return renderTomlDefinitionExport(input);
  const { renderDefinitionExport } = await loadYaml();
  return renderDefinitionExport(input, format);
}

export function exportFileName(
  project: string,
  revision: number,
  format: DefinitionFormat,
) {
  const safe = project.replace(/[^A-Za-z0-9._-]+/g, "-");
  return `${safe}-definitions-r${revision}.${format === "yaml" ? "yaml" : "toml"}`;
}

/** Save text as a file through a temporary object URL. */
export function downloadText(text: string, filename: string) {
  const type = filename.endsWith(".yaml") ? "application/yaml" : "text/plain";
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
