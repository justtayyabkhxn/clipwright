import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  typescript: {
    ignoreBuildErrors: false,
  },
  // The font routes read the bundled TTFs from web/fonts at runtime; ship them with those functions.
  outputFileTracingIncludes: {
    "/api/fonts": ["./fonts/**/*"],
    "/api/fonts/[fontName]": ["./fonts/**/*"],
  },
};

export default withNextIntl(nextConfig);
