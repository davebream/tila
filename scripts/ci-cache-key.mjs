import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { toolchain } from "./toolchain.mjs";

const identity = toolchain();
const hash = (value) => createHash("sha256").update(value).digest("hex");
const prefix = `tila-v1-${hash(identity)}-${hash(readFileSync("pnpm-lock.yaml"))}`;
appendFileSync(process.env.GITHUB_OUTPUT, `prefix=${prefix}\n`);
console.log(`Cache toolchain: ${identity}`);
