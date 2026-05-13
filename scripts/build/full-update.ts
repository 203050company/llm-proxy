#!/usr/bin/env tsx

import { spawnSync } from "child_process";
import { resolve } from "path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const dryRun = process.argv.includes("--dry-run");

const check = spawnSync("tsx", [resolve(ROOT, "scripts/build/check-update.ts")], {
  cwd: ROOT,
  stdio: "inherit",
});
if (check.status !== 0) process.exit(check.status ?? 1);

const apply = spawnSync("tsx", [
  resolve(ROOT, "scripts/build/apply-update.ts"),
  ...(dryRun ? ["--dry-run"] : []),
], {
  cwd: ROOT,
  stdio: "inherit",
});
process.exit(apply.status ?? 0);
