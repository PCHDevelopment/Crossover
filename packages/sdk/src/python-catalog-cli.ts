import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderPythonCatalog, renderPythonStub } from "./python-catalog.js";

/** Regenerate the Python SDK's catalog files: `pnpm --filter @crossover/sdk gen:python`. */
const dir = fileURLToPath(new URL("../../../clients/python/crossover_sdk/", import.meta.url));
writeFileSync(`${dir}_catalog.py`, renderPythonCatalog());
writeFileSync(`${dir}typed_api.pyi`, renderPythonStub());
