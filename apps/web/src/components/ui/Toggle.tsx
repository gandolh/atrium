import { Toggle as BaseToggle } from "@base-ui/react/toggle";
import type { ComponentProps } from "react";

type WithClass<P> = Omit<P, "className"> & { className?: string };

export interface ToggleProps extends WithClass<Omit<ComponentProps<typeof BaseToggle>, "pressed" | "onPressedChange">> {
  pressed: boolean;
  onPressedChange: (pressed: boolean) => void;
}

/**
 * A button that is on or off, on its own (a view mode, a mute, a colour in a palette). Controlled. A choice of one
 * among several is a RadioGroup or a ToggleGroup instead (base-ui rule 16).
 */
export function Toggle({ pressed, onPressedChange, className, ...props }: ToggleProps) {
  return <BaseToggle {...props} pressed={pressed} onPressedChange={onPressedChange} className={className} />;
}
