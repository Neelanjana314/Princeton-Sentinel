type InfoTooltipProps = {
  label: string;
  className?: string;
};

export function InfoTooltip({ label, className }: InfoTooltipProps) {
  return (
    <span className={className ? `group relative inline-flex ${className}` : "group relative inline-flex"}>
      <button
        type="button"
        aria-label={label}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full border text-[10px] leading-none text-muted-foreground outline-none transition-colors hover:bg-muted focus-visible:bg-muted"
      >
        i
      </button>
      <span className="pointer-events-none absolute left-1/2 top-full z-50 mt-2 hidden w-64 -translate-x-1/2 rounded-md border bg-background px-3 py-2 text-left text-xs font-normal leading-5 text-foreground shadow-md group-hover:block group-focus-within:block">
        {label}
      </span>
    </span>
  );
}
