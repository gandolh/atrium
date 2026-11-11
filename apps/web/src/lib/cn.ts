import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge, told this app's own `@theme` names (styles/globals.css). Without the lists below it reads
 * `rounded-card` as an unknown class and `z-popup` as a value it can't compare, so a later class would not win
 * over an earlier one. Keep the lists in step with `@theme` when a token is added.
 *
 * A font size must not remove a `leading-*`, which tailwind-merge does by default: this app's `text-[…]` sizes
 * carry no line height of their own, so `cn("leading-snug", "text-sm")` keeps both.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      font: ["display", "reading", "ui", "code"],
      radius: ["card", "cover", "chip"],
      shadow: ["l1", "lift"],
      ease: ["paper"],
    },
    classGroups: {
      z: [{ z: ["raised", "sticky", "chrome", "overlay", "dock", "popup", "toast"] }],
    },
  },
  override: {
    conflictingClassGroups: { "font-size": [] },
  },
});

/** Joins class names, and lets a later class win over an earlier one it conflicts with. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
