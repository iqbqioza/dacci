import { createSignal } from "solid-js";

/**
 * How a post that asks to be approved is shown. NIP-36 leaves the decision to
 * the client, and the three answers are genuinely different: `show` trusts the
 * reader to have chosen, `blur` keeps the shape of the post visible so the
 * feed does not jump while covering what is in it, and `hide` does not put the
 * text in the document at all, so a screenshot or a copy cannot reach it.
 */
export type SensitiveMode = "show" | "blur" | "hide";

const STORAGE_KEY = "dacci.sensitive";
/** Covering the post and asking before it is shown, as most clients do. */
const DEFAULT_MODE: SensitiveMode = "blur";

const [mode, setModeValue] = createSignal<SensitiveMode>(read());

function read(): SensitiveMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === "show" || raw === "hide" ? raw : DEFAULT_MODE;
  } catch {
    // A browser that refuses storage still gets the default for this visit.
    return DEFAULT_MODE;
  }
}

/** The reader's choice, and how to change it. */
export function useSensitiveMode(): {
  mode: () => SensitiveMode;
  setMode: (next: SensitiveMode) => void;
} {
  return { mode, setMode };
}

export function setMode(next: SensitiveMode): void {
  setModeValue(next);
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Without the note the choice applies for this visit all the same.
  }
}

/** The label each choice carries in the settings. */
export const SENSITIVE_MODE_LABELS: Record<SensitiveMode, string> = {
  show: "すべて表示",
  blur: "ぼかす",
  hide: "表示しない",
};
