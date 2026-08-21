export function publicAssetUrl(value: string | null | undefined): string {
  const normalized = value?.trim();
  if (!normalized) return "";
  if (normalized.startsWith("/") || /^(?:https?:|data:|blob:)/i.test(normalized)) {
    return normalized;
  }
  return `/${normalized}`;
}
