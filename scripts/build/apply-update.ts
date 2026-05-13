#!/usr/bin/env tsx

import { existsSync } from "fs";
import { resolve } from "path";
import { mutateYaml } from "../../src/utils/yaml-mutate.js";

const ROOT = resolve(import.meta.dirname, "..", "..");
const localConfig = resolve(ROOT, "config/local.yaml");

if (!existsSync(resolve(ROOT, "package.json"))) {
  throw new Error(`Repository root not found from ${ROOT}`);
}

if (process.argv.includes("--dry-run")) {
  console.log(JSON.stringify({ ok: true, dryRun: true, root: ROOT }));
} else if (existsSync(localConfig)) {
  mutateYaml(localConfig, (data) => {
    data.update_checked_at = new Date().toISOString();
  });
  console.log(JSON.stringify({ ok: true, root: ROOT }));
} else {
  console.log(JSON.stringify({ ok: true, root: ROOT, skipped: "config/local.yaml not found" }));
}
