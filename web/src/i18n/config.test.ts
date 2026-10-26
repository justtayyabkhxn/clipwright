import { readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { NAMESPACES } from "./config";

describe("message catalogs", () => {
  it("ships exactly one English file per namespace", () => {
    const files = readdirSync(join(process.cwd(), "messages/en")).filter((file) => file.endsWith(".json")).sort();
    expect(files).toEqual(NAMESPACES.map((namespace) => `${namespace}.json`).sort());
  });
});
