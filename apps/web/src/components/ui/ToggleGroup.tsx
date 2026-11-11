import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup as BaseToggleGroup } from "@base-ui/react/toggle-group";
import type { ComponentProps, ReactNode } from "react";

type WithClass<P> = Omit<P, "className"> & { className?: string };

export interface ToggleGroupProps<Value extends string> {
  /** Names the group for a screen reader. */
  label: string;
  value: Value;
  onValueChange: (value: Value) => void;
  className?: string;
  children: ReactNode;
}

/**
 * A picker that is saved to the server on each choice (base-ui rule 16): the theme, the reading font. The arrow keys
 * only move focus; Space, Enter or a click chooses, and chooses once. One item always stays pressed, so pressing
 * the pressed one again changes nothing. A choice that writes nothing is a RadioGroup instead.
 *
 * `ToggleGroup`'s value is an array even for one choice, so the guard lives here: an empty value (the pressed item
 * pressed again) and the value already held are not choices.
 */
export function ToggleGroup<Value extends string>({
  label,
  value,
  onValueChange,
  className,
  children,
}: ToggleGroupProps<Value>) {
  return (
    <BaseToggleGroup
      aria-label={label}
      value={[value]}
      onValueChange={(next) => {
        const chosen = next[0];
        if (chosen !== undefined && chosen !== value) onValueChange(chosen as Value);
      }}
      className={className}
    >
      {children}
    </BaseToggleGroup>
  );
}

export interface ToggleItemProps extends WithClass<ComponentProps<typeof Toggle>> {
  value: string;
  children?: ReactNode;
}

/** One option of a ToggleGroup. The look is the caller's `className`, state through `data-pressed:`. */
export function ToggleItem({ className, children, ...props }: ToggleItemProps) {
  return (
    <Toggle {...props} className={className}>
      {children}
    </Toggle>
  );
}
