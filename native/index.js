/* tslint:disable */
/* eslint-disable */
/* prettier-ignore */

const { existsSync } = require("fs");
const { join } = require("path");

const { platform, arch } = process;

function bindingCandidates() {
  if (platform === "linux" && arch === "x64") {
    return ["codex-tls.linux-x64-gnu.node", "codex-tls.linux-x64-musl.node"];
  }
  if (platform === "linux" && arch === "arm64") {
    return ["codex-tls.linux-arm64-gnu.node", "codex-tls.linux-arm64-musl.node"];
  }
  if (platform === "darwin" && arch === "arm64") {
    return ["codex-tls.darwin-arm64.node"];
  }
  if (platform === "darwin" && arch === "x64") {
    return ["codex-tls.darwin-x64.node"];
  }
  if (platform === "win32" && arch === "x64") {
    return ["codex-tls.win32-x64-msvc.node"];
  }
  if (platform === "win32" && arch === "arm64") {
    return ["codex-tls.win32-arm64-msvc.node"];
  }
  return [];
}

let nativeBinding = null;
const loadErrors = [];

for (const filename of bindingCandidates()) {
  const bindingPath = join(__dirname, filename);
  if (!existsSync(bindingPath)) continue;
  try {
    nativeBinding = require(bindingPath);
    break;
  } catch (err) {
    loadErrors.push(`${filename}: ${err && err.message ? err.message : String(err)}`);
  }
}

if (!nativeBinding) {
  const candidates = bindingCandidates().join(", ") || `${platform}-${arch}`;
  const suffix = loadErrors.length ? ` Load errors: ${loadErrors.join("; ")}` : "";
  throw new Error(`Native addon not found for ${platform}-${arch}. Checked: ${candidates}.${suffix}`);
}

const { httpGet, httpPost, httpPostStream } = nativeBinding;

module.exports.httpGet = httpGet;
module.exports.httpPost = httpPost;
module.exports.httpPostStream = httpPostStream;
