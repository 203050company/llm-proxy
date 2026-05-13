#!/usr/bin/env tsx

import { existsSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const marker = resolve(ROOT, "package.json");

if (!existsSync(marker)) {
  throw new Error(`Repository root not found from ${ROOT}`);
}

console.log(JSON.stringify({ ok: true, root: ROOT }));
