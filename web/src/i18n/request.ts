import { getRequestConfig } from "next-intl/server";

import { locale } from "./config";
import { loadMessages } from "./load-messages";

export default getRequestConfig(async () => ({
  locale,
  messages: await loadMessages(),
}));
