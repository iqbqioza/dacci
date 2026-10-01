import { createSignal } from "solid-js";

/**
 * What the reader asked for: follow the system, or a theme either way. It is
 * stored rather than derived so the choice survives a reload, and `system` is
 * the default because a reader who has never been asked should get whatever
 * their device is already doing.
 */
export type Theme = "system" | "light" | "dark";

const STORAGE_KEY = "dacci.theme";
/** The class the stylesheet hangs the dark theme on. */
const DARK_CLASS = "dark";

const [theme, setThemeValue] = createSignal<Theme>(read());

function read(): Theme {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === "light" || raw === "dark" ? raw : "system";
  } catch {
    // A browser that refuses storage still gets a theme, it just forgets it.
    return "system";
  }
}

function write(next: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Without the note the theme applies for this visit all the same.
  }
}

/** The theme in force, which is the request answered against the system. */
export function useTheme(): {
  theme: () => Theme;
  /** What `theme` resolves to: `system` answered by the device. */
  resolved: () => "light" | "dark";
  /** Records the choice and puts it on the document at once. */
  setTheme: (next: Theme) => void;
} {
  return { theme, resolved, setTheme };
}

/** What the system is asking for, or `false` where there is no answer. */
function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function resolved(): "light" | "dark" {
  const asked = theme();
  if (asked !== "system") return asked;
  return systemPrefersDark() ? "dark" : "light";
}

function setTheme(next: Theme): void {
  setThemeValue(next);
  write(next);
  apply();
}

function apply(): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle(DARK_CLASS, resolved() === "dark");
}

/**
 * Puts the stored theme on the document and keeps it there. The dark class
 * is what the stylesheet reads, and the media query is followed live, so
 * `system` changes with the device rather than only at a reload.
 *
 * `index.html` sets the same class from the same key before the page paints,
 * which is what keeps a dark reader from seeing a white flash first.
 */
export function startTheme(): void {
  apply();
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return;
  }
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = (): void => {
    if (theme() === "system") apply();
  };
  // Safari before 14 only has the deprecated form.
  if (typeof query.addEventListener === "function") {
    query.addEventListener("change", onChange);
  } else if (typeof query.addListener === "function") {
    query.addListener(onChange);
  }
}
