import type { ButtonHTMLAttributes } from 'react';

// Keep unavailable actions focusable so touch and keyboard users can ask why.
// The blocked click must never reach the operation or submit its parent form.
export function AvailabilityButton({
  reason,
  explain,
  onClick,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  reason?: string;
  explain: (reason: string) => void;
}) {
  return (
    <button
      {...props}
      aria-disabled={reason ? true : undefined}
      aria-description={reason || undefined}
      title={reason || props.title}
      onClick={(event) => {
        if (reason) {
          event.preventDefault();
          event.stopPropagation();
          explain(reason);
        } else onClick?.(event);
      }}
    />
  );
}
