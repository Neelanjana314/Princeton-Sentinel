type AdminVersionBadgeProps = {
  version: string;
};

export default function AdminVersionBadge({ version }: AdminVersionBadgeProps) {
  return (
    <span className="inline-flex items-center rounded-full border border-primary/30 bg-primary/12 px-2.5 py-0.5 text-xs font-semibold text-foreground">
      Version {version}
    </span>
  );
}
