import type { AbstractIntlMessages } from "next-intl";

import { NAMESPACES } from "./config";

export async function loadMessages(): Promise<AbstractIntlMessages> {
  const entries = await Promise.all(
    NAMESPACES.map(async (namespace) => {
      const messages = (await import(`../../messages/en/${namespace}.json`)).default as AbstractIntlMessages;
      return [namespace, messages] as const;
    }),
  );

  return Object.fromEntries(entries);
}
