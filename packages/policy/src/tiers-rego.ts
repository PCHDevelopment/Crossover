import { CAPABILITIES } from "./bundles.js";
import { CATALOG_TIER_3, EXTERNAL_TIERS, SCOPED_TIER_RULES } from "./tiers.js";

/**
 * policy/tiers.gen.rego: the data the tier rules (tiers.rego) classify from, written from
 * tiers.ts and the capability catalog of bundles.ts, which stay the single source: `gen:wasm`
 * writes this file and CI fails when the committed copy is stale. `gen:wasm` formats it with
 * `opa fmt`, so the text here is unformatted.
 */
export function renderTiersRego(): string {
  const object = (name: string, entries: [string, string][]): string =>
    `${name} := {\n${entries.map(([key, value]) => `\t${JSON.stringify(key)}: ${value},\n`).join("")}}\n`;
  return [
    "# Generated from src/tiers.ts and src/bundles.ts by gen:wasm: do not edit.\n",
    "package crossover.tier_data\n",
    "import rego.v1\n",
    object(
      "external",
      Object.entries(EXTERNAL_TIERS).map(([key, tier]) => [key, String(tier)]),
    ),
    object(
      "scoped",
      Object.entries(SCOPED_TIER_RULES).map(([key, rule]) => [
        key,
        `{"prefix": ${JSON.stringify(rule.prefix)}, "tier": ${rule.tier}, "otherwise": ${rule.otherwise}}`,
      ]),
    ),
    // Catalog capability -> does it change state (tier 1) or only read (tier 0).
    object(
      "catalog_mutating",
      Object.entries(CAPABILITIES).map(([key, entry]) => [key, String(entry.mutating)]),
    ),
    `catalog_tier_3 := {\n${[...CATALOG_TIER_3].map((key) => `\t${JSON.stringify(key)},\n`).join("")}}\n`,
  ].join("\n");
}
