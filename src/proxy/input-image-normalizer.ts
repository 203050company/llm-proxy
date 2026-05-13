import sharp from "sharp";

import type {
  CodexContentPart,
  CodexInputItem,
  CodexResponsesRequest,
} from "./codex-types.js";
import { isDataImageUrl, unwrapNestedDataImageUrl } from "../utils/data-image-url.js";

const DATA_IMAGE_URL_RE = /^data:(image\/[a-z0-9.+-]+)(?:;[^;,=]+(?:=[^;,]+)?)*;base64,([\s\S]+)$/i;

const IMAGE_FAILURE_PLACEHOLDER =
  "[image omitted: proxy could not decode the attached image]";

interface NormalizeOutcome {
  /** Returned image_url when successful or when no-op. Null when the image should be dropped. */
  imageUrl: string | null;
  /** True when a data URL was rejected and must be replaced with a placeholder text part. */
  dropped: boolean;
  /** Optional diagnostic for logging when dropped. */
  reason?: string;
}

function isUserMessageWithParts(
  item: CodexInputItem,
): item is { role: "user"; content: CodexContentPart[] } {
  return "role" in item && item.role === "user" && Array.isArray(item.content);
}

function toDataUrl(mimeType: string, buffer: Buffer): string {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

async function normalizeImageDataUrl(imageUrl: string): Promise<NormalizeOutcome> {
  const unwrapped = unwrapNestedDataImageUrl(imageUrl);
  const match = DATA_IMAGE_URL_RE.exec(unwrapped);
  // Non-data URLs (http(s)://…) pass through unchanged — upstream handles them.
  if (!match) return { imageUrl, dropped: false };

  const [, , encoded] = match;

  try {
    const buffer = Buffer.from(encoded.replace(/\s+/g, ""), "base64");
    const nestedText = buffer.toString("utf8").trim();
    if (isDataImageUrl(nestedText)) {
      return normalizeImageDataUrl(nestedText);
    }
    const normalized = await sharp(buffer, { animated: false })
      .rotate()
      .png()
      .toBuffer();
    return { imageUrl: toDataUrl("image/png", normalized), dropped: false };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { imageUrl: null, dropped: true, reason };
  }
}

async function normalizeContentParts(parts: CodexContentPart[]): Promise<CodexContentPart[]> {
  let changed = false;

  const normalized = await Promise.all(parts.map(async (part): Promise<CodexContentPart> => {
    if (part.type !== "input_image") return part;

    const outcome = await normalizeImageDataUrl(part.image_url);
    if (outcome.dropped) {
      changed = true;
      const prefix = part.image_url.slice(0, 80).replace(/\s+/g, " ");
      console.warn(
        `[InputImage] dropping unreadable image (${outcome.reason ?? "decode failed"}): ${prefix}${part.image_url.length > 80 ? "…" : ""}`,
      );
      return { type: "input_text", text: IMAGE_FAILURE_PLACEHOLDER };
    }
    if (outcome.imageUrl === part.image_url) return part;

    changed = true;
    return { ...part, image_url: outcome.imageUrl! };
  }));

  return changed ? normalized : parts;
}

export async function normalizeRequestInputImages(
  request: CodexResponsesRequest,
): Promise<CodexResponsesRequest> {
  let changed = false;

  const input = await Promise.all(request.input.map(async (item) => {
    if (!isUserMessageWithParts(item)) return item;

    const content = await normalizeContentParts(item.content);
    if (content === item.content) return item;

    changed = true;
    return { ...item, content };
  }));

  return changed ? { ...request, input } : request;
}
