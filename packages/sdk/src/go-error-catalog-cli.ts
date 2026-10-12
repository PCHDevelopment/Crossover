import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderGoErrorCatalog } from "./go-error-catalog.js";

/** Regenerate the Go CLI's public protocol error exit codes. */
const dir = fileURLToPath(new URL("../../../clients/go/internal/cli/", import.meta.url));
writeFileSync(`${dir}error_codes_gen.go`, renderGoErrorCatalog());
