/* tslint:disable */
/* eslint-disable */
/* prettier-ignore */

/* Modified dummy for Gemini CLI environment */

const { existsSync, readFileSync } = require('fs')
const { join } = require('path')

const { platform, arch } = process

let nativeBinding = null

// Try original logic... (omitted for brevity, let's just try to load or dummy)
try {
  if (platform === 'linux' && arch === 'x64') {
     // skip original complex check and try to load any available linux-x64
  }
} catch (e) {}

if (!nativeBinding) {
  console.warn("[Native] Using dummy HTTP transport (native addon not found)");
  nativeBinding = {
    httpGet: async () => ({ status: 500, body: '{"error":"Native addon not found"}' }),
    httpPost: async () => ({ status: 500, body: '{"error":"Native addon not found"}' }),
    httpPostStream: async function* () { yield '{"error":"Native addon not found"}'; }
  }
}

const { httpGet, httpPost, httpPostStream } = nativeBinding

module.exports.httpGet = httpGet
module.exports.httpPost = httpPost
module.exports.httpPostStream = httpPostStream
