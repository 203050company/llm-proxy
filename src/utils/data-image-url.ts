const DATA_IMAGE_URL_RE = /^data:(image\/[a-z0-9.+-]+)(?:;[^;,=]+(?:=[^;,]+)?)*;base64,([\s\S]+)$/i;

export function isDataImageUrl(value: string): boolean {
  return /^data:image\//i.test(value.trim());
}

export function toDataImageUrl(
  mimeType: string,
  data: string,
): string {
  const trimmed = data.trim();
  return isDataImageUrl(trimmed)
    ? trimmed
    : `data:${mimeType};base64,${trimmed}`;
}

export function unwrapNestedDataImageUrl(value: string): string {
  let current = value.trim();
  const seen = new Set<string>();

  for (;;) {
    const match = DATA_IMAGE_URL_RE.exec(current);
    if (!match) return current;

    const nested = match[2].trim();
    if (!isDataImageUrl(nested) || seen.has(nested)) return current;

    seen.add(current);
    current = nested;
  }
}
