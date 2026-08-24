import test from "node:test";
import assert from "node:assert/strict";
import { createBuiltinRegistry } from "./builtin.js";

test("built-in plugin registry exposes phase 3 modules", () => {
  const ids = createBuiltinRegistry().list().map((p) => p.id);
  assert.deepEqual(ids, ["cards", "pos", "reports", "posbox", "shop"]);
});
