// Compatibility entry point for existing source development commands.
process.argv[2] = "sdk";
await import("../../../scripts/generate-version.mjs");
