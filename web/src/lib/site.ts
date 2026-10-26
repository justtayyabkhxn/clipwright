export const SITE_NAME = "Clipwright";
export const DEFAULT_SITE_URL = "http://localhost:3000";
/** Upstream project this app is based on; AGPL-3.0 requires offering the source. */
export const SOURCE_CODE_URL = process.env.NEXT_PUBLIC_SOURCE_CODE_URL || "https://github.com/FujiwaraChoki/supoclip";

export function getSiteUrl() {
  try {
    return new URL(process.env.NEXT_PUBLIC_APP_URL || DEFAULT_SITE_URL).origin;
  } catch {
    return DEFAULT_SITE_URL;
  }
}
