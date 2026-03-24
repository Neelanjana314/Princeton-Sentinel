import { formatIsoDateTime } from "@/app/lib/format";
import { describeAvailabilityReason } from "@/app/lib/site-availability";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type SiteAvailabilityNoticeProps = {
  isAvailable: boolean | null;
  lastAvailableAt: string | null;
  availabilityReason: string | null;
};

export function SiteAvailabilityNotice({
  isAvailable,
  lastAvailableAt,
  availabilityReason,
}: SiteAvailabilityNoticeProps) {
  if (isAvailable !== false) return null;

  return (
    <Card className="border-amber-500/30 bg-amber-500/5">
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>Cached-only view</CardTitle>
          <Badge className="border-amber-500/30 bg-amber-500/10 text-amber-900">Unavailable in Graph</Badge>
        </div>
        <CardDescription>
          Current sync jobs will skip this drive because Graph no longer returns accessible content for it.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2 text-sm text-muted-foreground">
        <div>Last available: {formatIsoDateTime(lastAvailableAt)}</div>
        <div>Reason: {describeAvailabilityReason(availabilityReason)}</div>
      </CardContent>
    </Card>
  );
}
