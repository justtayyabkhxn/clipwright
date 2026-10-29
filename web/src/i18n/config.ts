export const locale = "en";

/** Message files under `web/messages/en/`. */
export const NAMESPACES = [
  "common",
  "metadata",
  "shell",
  "auth",
  "settings",
  "home",
  "library",
  "task",
  "editor",
  "youtube",
] as const;

export type Namespace = (typeof NAMESPACES)[number];
