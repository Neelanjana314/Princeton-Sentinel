import type { AdminJobControlState } from "@/app/admin/job-control";
import { Card, CardContent } from "@/components/ui/card";

export default function AdminJobControlNotice({ state }: { state: AdminJobControlState }) {
  if (state.jobControlEnabled) {
    return null;
  }

  return (
    <Card className="border-amber-500/30 bg-amber-500/5">
      <CardContent className="pt-6 text-sm text-foreground">
        <span className="font-semibold">Read-only mode.</span> {state.message}
      </CardContent>
    </Card>
  );
}
