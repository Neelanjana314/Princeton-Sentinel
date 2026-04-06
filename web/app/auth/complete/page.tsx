import { withPageRequestTiming } from "@/app/lib/request-timing";
import { sanitizeCallbackUrl } from "@/app/lib/callback-url";
import { PostAuthRedirect } from "@/app/auth/complete/post-auth-redirect";
import AuthShell from "@/components/auth-shell";
import { Button } from "@/components/ui/button";

type Props = {
  searchParams?: Promise<{ callbackUrl?: string | string[] }>;
};

export const dynamic = "force-dynamic";

async function AuthCompletePage({ searchParams }: Props) {
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const callbackUrl = sanitizeCallbackUrl(resolvedSearchParams?.callbackUrl);

  return (
    <AuthShell
      support="Authentication"
      title="Completing sign-in"
      subtitle="Finalizing your session before continuing to Princeton Sentinel."
    >
      <PostAuthRedirect callbackUrl={callbackUrl} />
      <div className="space-y-4 rounded-lg border bg-card p-6 text-sm text-muted-foreground shadow-sm">
        <p>Redirecting to your requested page.</p>
        <Button asChild className="w-full">
          <a href={callbackUrl}>Continue</a>
        </Button>
      </div>
    </AuthShell>
  );
}

export default withPageRequestTiming("/auth/complete", AuthCompletePage);
