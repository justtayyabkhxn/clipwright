export const SITE_NAME = "Clipwright";
export const DEFAULT_SITE_URL = "http://localhost:3000";
/** Public source of this app; AGPL-3.0 requires offering it to network users. */
export const SOURCE_CODE_URL = process.env.NEXT_PUBLIC_SOURCE_CODE_URL || "https://github.com/justtayyabkhxn/clipwright";

export function getSiteUrl() {
  try {
    return new URL(process.env.NEXT_PUBLIC_APP_URL || DEFAULT_SITE_URL).origin;
  } catch {
    return DEFAULT_SITE_URL;
  }
}
