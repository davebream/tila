// Compatibility entry point for existing source development commands.
process.argv[2] = "cli";
await import("../../../scripts/generate-version.mjs");
