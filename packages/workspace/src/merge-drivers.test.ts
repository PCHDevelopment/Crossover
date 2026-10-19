import { afterEach, expect, it } from "vitest";
import {
  defaultMergeDrivers,
  setDefaultMergeDrivers,
  structuredMergeDrivers,
  type MergeDriver,
} from "./merge-drivers.js";

afterEach(() => setDefaultMergeDrivers([]));

it("keeps the default registry isolated from caller mutation and later tests", () => {
  const driver: MergeDriver = {
    name: "test",
    matches: () => true,
    merge: async () => ({ ok: true, content: "result" }),
  };
  const supplied = [driver];
  setDefaultMergeDrivers(supplied);
  supplied.pop();
  expect(defaultMergeDrivers()).toEqual([driver]);
  expect(Object.isFrozen(defaultMergeDrivers())).toBe(true);
  setDefaultMergeDrivers([]);
  expect(defaultMergeDrivers()).toEqual([]);
  expect(structuredMergeDrivers()).toEqual([]);
});
