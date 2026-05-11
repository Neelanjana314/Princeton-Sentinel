import { withPageRequestTiming } from "@/app/lib/request-timing";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getServerSession } from "next-auth/next";

import { sanitizeAccountHint, LAST_ACCOUNT_HINT_COOKIE } from "@/app/lib/account-hint";
import { getAuthOptions } from "@/app/lib/auth";
import { sanitizeCallbackUrl } from "@/app/lib/callback-url";
import { AccountSignInButtons } from "@/app/signin/account/account-sign-in-buttons";
import AuthShell from "@/components/auth-shell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Props = {
  searchParams?: Promise<{ callbackUrl?: string | string[]; error?: string | string[] }>;
};

export const dynamic = "force-dynamic";

async function SignInAccountPage({ searchParams }: Props) {
  const session = await getServerSession(getAuthOptions());
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const callbackUrl = sanitizeCallbackUrl(resolvedSearchParams?.callbackUrl);
  const error = typeof resolvedSearchParams?.error === "string" ? resolvedSearchParams.error : undefined;

  if (session?.user) {
    redirect(callbackUrl);
  }

  const cookieStore = await cookies();
  const accountHint = sanitizeAccountHint(cookieStore.get(LAST_ACCOUNT_HINT_COOKIE)?.value);

  return (
    <AuthShell
      support="Authentication"
      title="Sign in to Princeton Sentinel"
      subtitle="Use Microsoft Entra ID to access the Princeton Sentinel dashboard."
    >
      <Card>
        <CardHeader>
          <CardTitle>Continue with Entra ID</CardTitle>
          <CardDescription>Use your approved organization account to access dashboard data.</CardDescription>
        </CardHeader>
        <CardContent>
          <AccountSignInButtons callbackUrl={callbackUrl} initialError={error} accountHint={accountHint} />
        </CardContent>
      </Card>
    </AuthShell>
  );
}

export default withPageRequestTiming("/signin/account", SignInAccountPage);
