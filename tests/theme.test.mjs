import assert from "node:assert/strict";
import test from "node:test";

import {
  THEME_STORAGE_KEY,
  normalizeThemePreference,
  resolveTheme,
} from "../lib/theme.ts";

test("normalizes missing and invalid theme preferences to system", () => {
  assert.equal(THEME_STORAGE_KEY, "relix:theme");

  for (const value of [undefined, null, "", "auto", "LIGHT", 0, false, {}]) {
    assert.equal(normalizeThemePreference(value), "system");
  }

  for (const preference of ["system", "light", "dark"]) {
    assert.equal(normalizeThemePreference(preference), preference);
  }
});

test("resolves system, light, and dark preferences for either OS theme", () => {
  const cases = [
    ["system", false, "light"],
    ["system", true, "dark"],
    ["light", false, "light"],
    ["light", true, "light"],
    ["dark", false, "dark"],
    ["dark", true, "dark"],
  ];

  for (const [preference, systemDark, expected] of cases) {
    assert.equal(
      resolveTheme(preference, systemDark),
      expected,
      `${preference} with systemDark=${systemDark} should resolve to ${expected}`,
    );
  }
});
