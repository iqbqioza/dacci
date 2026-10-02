import { describe, expect, it } from "vitest";
import { swatchStyle } from "./Choices.jsx";
import { THEME_CHOICES } from "./Views.jsx";

/**
 * A swatch is an inline style, so whether it draws at all is decided by the
 * browser's CSS parser and not by anything TypeScript can see. The parser
 * discards a declaration it cannot parse — it does not fall back — so a value
 * that is valid CSS text but invalid for the property it is given renders as
 * nothing at all, silently. The check below is the same one the parser makes.
 *
 * Scope, stated so the next reader does not assume more: this covers the property
 * the value is given. The other half of that bug was in the markup — the render
 * prop of a `Show` is handed whatever `when` holds, so testing it for `!== undefined`
 * handed it a boolean and every swatch was painted `background: true`. There is
 * no DOM in this package, so that half cannot be rendered here; it was confirmed
 * against the running app, where all three swatches now paint.
 */

/** What the parser accepts for a `<color>`, which is all `background-color` takes. */
const COLOR = /^(#[0-9a-f]{3,8}|[a-z]+)$/i;
/** What the parser accepts for a `<image>`, of which only gradients are offered. */
const GRADIENT = /^linear-gradient\(.+\)$/;

function parse(style: string): { property: string; value: string } | null {
  const at = style.indexOf(":");
  if (at < 1) return null;
  return { property: style.slice(0, at).trim(), value: style.slice(at + 1).trim() };
}

describe("a theme swatch", () => {
  it("is drawn by a property its own value is valid for", () => {
    // Every option's swatch has to survive the property it is set through. The
    // system theme is a gradient and `background-color` only takes a colour, so
    // that one was discarded and drew as an empty outlined pill — on a screen
    // whose stated purpose is that the choice can be judged from the row rather
    // than by pressing it.
    for (const choice of THEME_CHOICES) {
      const decl = parse(swatchStyle(choice.swatch));
      expect(decl, choice.id).not.toBeNull();
      const value = decl?.value ?? "";
      const accepted =
        decl?.property === "background-color" ? COLOR.test(value) : true;
      expect(accepted, `${choice.id}: ${decl?.property}: ${value}`).toBe(true);
      if (decl?.property !== "background-color") {
        expect(COLOR.test(value) || GRADIENT.test(value), choice.id).toBe(true);
      }
    }
  });

  it("offers a swatch for every option, so each can be judged from the row", () => {
    // The control exists so the choice can be read off the screen rather than
    // tried. An option with no swatch is an option that has to be pressed, and
    // with nothing painted in the pill there is nothing to read.
    expect(THEME_CHOICES.length).toBeGreaterThan(1);
    expect(THEME_CHOICES.every((c) => c.swatch !== undefined)).toBe(true);
  });

  it("has at least one swatch that is not a plain colour", () => {
    // The reason the property cannot be the colour-only one is here in the data,
    // not only in a comment: if every swatch were a hex colour the narrower
    // property would be fine, and nothing would notice until a gradient was
    // offered and silently did not draw.
    expect(THEME_CHOICES.some((c) => GRADIENT.test(c.swatch))).toBe(true);
  });
});
