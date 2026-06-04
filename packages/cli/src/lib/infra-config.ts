import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type TilaInfraConfig, TilaInfraConfigSchema } from "@tila/schemas";
import { parse, stringify } from "smol-toml";

export const INFRA_DIR_NAME = ".tila";
export const INFRA_CONFIG_FILE = "infra.toml";

export function loadInfraConfig(tilaDir: string): TilaInfraConfig {
  const filePath = join(tilaDir, INFRA_CONFIG_FILE);
  if (!existsSync(filePath)) {
    throw new Error(
      `No infra.toml found at ${filePath}. Run \`tila infra provision\` first.`,
    );
  }

  const raw = readFileSync(filePath, "utf-8");
  const parsed = parse(raw);
  const result = TilaInfraConfigSchema.safeParse(parsed);

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid infra.toml at ${filePath}:\n${issues}`);
  }

  return result.data;
}

export function getInfraSlug(config: TilaInfraConfig): string {
  return config.infra_slug ?? "tila";
}

export function writeInfraConfig(
  config: TilaInfraConfig,
  tilaDir: string,
): void {
  const result = TilaInfraConfigSchema.safeParse(config);
  if (!result.success) {
    throw new Error(
      `Cannot write invalid infra config: ${result.error.message}`,
    );
  }

  mkdirSync(tilaDir, { recursive: true, mode: 0o700 });

  const filePath = join(tilaDir, INFRA_CONFIG_FILE);
  writeFileSync(filePath, stringify(result.data), { mode: 0o600 });
}
