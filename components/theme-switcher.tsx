"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";
import {
  THEME_STORAGE_KEY,
  normalizeThemePreference,
  resolveTheme,
  type ThemePreference,
} from "@/lib/theme";

const THEME_OPTIONS = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
] satisfies Array<{
  value: ThemePreference;
  label: string;
  icon: typeof Monitor;
}>;

const THEME_CHANGE_EVENT = "relix-theme-change";

function applyTheme(preference: ThemePreference) {
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const resolved = resolveTheme(preference, systemDark);
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.dataset.themePreference = preference;
  root.style.colorScheme = resolved;
}

function getThemeSnapshot() {
  return normalizeThemePreference(document.documentElement.dataset.themePreference);
}

function getServerThemeSnapshot(): ThemePreference | null {
  return null;
}

function subscribeToTheme(onStoreChange: () => void) {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const onSystemThemeChange = () => {
    if (getThemeSnapshot() === "system") applyTheme("system");
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== THEME_STORAGE_KEY) return;
    applyTheme(normalizeThemePreference(event.newValue));
    onStoreChange();
  };
  media.addEventListener("change", onSystemThemeChange);
  window.addEventListener("storage", onStorage);
  window.addEventListener(THEME_CHANGE_EVENT, onStoreChange);
  return () => {
    media.removeEventListener("change", onSystemThemeChange);
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(THEME_CHANGE_EVENT, onStoreChange);
  };
}

export function ThemeSwitcher() {
  const preference = useSyncExternalStore<ThemePreference | null>(
    subscribeToTheme,
    getThemeSnapshot,
    getServerThemeSnapshot,
  );
  const activeIndex = Math.max(
    0,
    THEME_OPTIONS.findIndex((option) => option.value === preference),
  );
  const activeOption = THEME_OPTIONS[activeIndex];
  const nextOption = THEME_OPTIONS[(activeIndex + 1) % THEME_OPTIONS.length];
  const ActiveIcon = activeOption.icon;

  const chooseTheme = (next: ThemePreference) => {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // The active theme still applies for this session when storage is blocked.
    }
    applyTheme(next);
    window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
  };

  return (
    <div className="theme-switcher" role="group" aria-label="Color theme">
      {preference !== null && (
        <button
          className="theme-cycle-option"
          type="button"
          aria-label={`${activeOption.label} theme. Switch to ${nextOption.label} theme`}
          title={`${activeOption.label} theme · next: ${nextOption.label}`}
          onClick={() => chooseTheme(nextOption.value)}
        >
          <ActiveIcon size={14} aria-hidden="true" />
        </button>
      )}
      {THEME_OPTIONS.map((option) => {
        const Icon = option.icon;
        const selected = preference === option.value;
        return (
          <button
            className={`theme-option${selected ? " active" : ""}`}
            type="button"
            key={option.value}
            aria-label={`${option.label} theme`}
            aria-pressed={selected}
            title={`${option.label} theme`}
            onClick={() => chooseTheme(option.value)}
          >
            <Icon size={13} aria-hidden="true" />
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
