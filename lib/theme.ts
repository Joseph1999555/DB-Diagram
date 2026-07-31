export const THEME_STORAGE_KEY = "relix:theme";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export function normalizeThemePreference(value: unknown): ThemePreference {
  return value === "system" || value === "light" || value === "dark"
    ? value
    : "system";
}

export function resolveTheme(
  preference: ThemePreference,
  systemDark: boolean,
): ResolvedTheme {
  if (preference === "system") return systemDark ? "dark" : "light";
  return preference;
}
