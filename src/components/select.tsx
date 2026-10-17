'use client';
import * as RS from '@radix-ui/react-select';
import { cx } from './ui';

/** Radix items cannot use an empty value; '' (e.g. "All") is mapped to this sentinel. */
const EMPTY = '__empty__';

export type SelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
  /** Consecutive options with the same group are shown under one heading. */
  group?: string;
};

/**
 * Styled dropdown that looks the same in every browser (native popups are white in Brave/Chrome on
 * Windows and zoom on iOS). Keyboard and screen-reader behaviour come from Radix.
 */
export function Select({
  value,
  onChange,
  options,
  label,
  className,
  size = 'md',
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  /** Accessible name. */
  label: string;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  return (
    <RS.Root
      value={value === '' ? EMPTY : value}
      onValueChange={(v) => onChange(v === EMPTY ? '' : v)}
    >
      <RS.Trigger
        aria-label={label}
        className={cx(
          'text-fg inline-flex min-w-0 items-center justify-between gap-2 rounded-full bg-white/[0.08] pr-3 pl-3.5 text-left outline-none hover:bg-white/[0.12] focus-visible:ring-2 focus-visible:ring-white/70 data-[state=open]:bg-white/[0.12]',
          size === 'sm' ? 'h-8 text-[13px]' : size === 'lg' ? 'h-11 text-[15px]' : 'h-9 text-sm',
          className,
        )}
      >
        <span className="truncate">
          <RS.Value />
        </span>
        <RS.Icon className="text-mid shrink-0">
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </RS.Icon>
      </RS.Trigger>
      <RS.Portal>
        <RS.Content
          position="popper"
          sideOffset={6}
          className="z-[70] max-h-[min(360px,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-2xl bg-[#1c1a17] p-1 text-sm shadow-[0_18px_40px_rgba(0,0,0,0.55)] ring-1 ring-white/10"
        >
          <RS.Viewport>
            {options.map((o, i) => {
              const heading = o.group && o.group !== options[i - 1]?.group ? o.group : null;
              return (
                <div key={o.value || EMPTY}>
                  {heading && (
                    <div className="text-muted px-3 pt-2.5 pb-1 text-[11px] tracking-[0.12em] uppercase">
                      {heading}
                    </div>
                  )}
                  <RS.Item
                    value={o.value === '' ? EMPTY : o.value}
                    disabled={o.disabled}
                    className="text-soft flex min-h-9 cursor-default items-center justify-between gap-6 rounded-xl px-3 py-1.5 outline-none select-none data-[disabled]:opacity-40 data-[highlighted]:bg-white/[0.08] data-[highlighted]:text-white data-[state=checked]:font-semibold data-[state=checked]:text-white"
                  >
                    <RS.ItemText>{o.label}</RS.ItemText>
                    <RS.ItemIndicator aria-hidden>✓</RS.ItemIndicator>
                  </RS.Item>
                </div>
              );
            })}
          </RS.Viewport>
        </RS.Content>
      </RS.Portal>
    </RS.Root>
  );
}
