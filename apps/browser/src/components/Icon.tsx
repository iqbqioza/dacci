import {
  quoteRepostIcon,
  reactIcon,
  reactIconSolid,
  replyIcon,
  repostIcon,
  type Heroicon,
} from "dacci-icons";

const ICONS = {
  reply: replyIcon,
  repost: repostIcon,
  "quote-repost": quoteRepostIcon,
  react: reactIcon,
  "react-solid": reactIconSolid,
} as const satisfies Record<string, Heroicon>;

export type IconName = keyof typeof ICONS;

/**
 * Heroicons outline glyph, 24x24, inheriting the text colour. Path data is
 * vendored in dacci-icons, so no icon dependency ships to the browser.
 */
export function Icon(props: {
  name: IconName;
  class?: string;
  title?: string;
  /** Solid glyphs paint the shape; outline glyphs only stroke it. */
  filled?: boolean;
}) {
  const icon = ICONS[props.name];
  return (
    <svg
      viewBox="0 0 24 24"
      fill={props.filled === true ? "currentColor" : "none"}
      stroke="currentColor"
      stroke-width={props.filled === true ? undefined : "1.5"}
      class={props.class ?? "size-5"}
      role={props.title === undefined ? "presentation" : "img"}
      aria-hidden={props.title === undefined ? "true" : undefined}
    >
      {props.title !== undefined && <title>{props.title}</title>}
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        d={icon.d}
      />
    </svg>
  );
}
