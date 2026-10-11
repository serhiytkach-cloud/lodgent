import { BRAND } from '@lodgent/shared';
import Link from 'next/link';
import { Logo } from '@/components/logo';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert } from '@/components/ui/misc';
import { safeNext } from '@/lib/cognito';
import { webEnv } from '@/lib/env';
import { DevLoginForm } from './login-form';

export const metadata = { title: `Sign in · ${BRAND.name}` };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; expired?: string; error?: string }>;
}) {
  const params = await searchParams;
  const next = safeNext(params.next);
  const env = webEnv();
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          <Logo />
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Sign in to your hotel dashboard</CardTitle>
            <CardDescription>Manage how AI agents see and book your hotel.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {params.expired ? <Alert variant="warning">Your session expired. Sign in again.</Alert> : null}
            {params.error ? <Alert variant="error">Sign-in failed ({params.error}). Try again.</Alert> : null}
            {env.authProvider === 'cognito' ? (
              <Button asChild size="lg">
                <Link href={`/auth/login?next=${encodeURIComponent(next)}`}>Continue to sign in</Link>
              </Button>
            ) : (
              <>
                <Alert variant="info">Development sign-in: any email works, no password.</Alert>
                <DevLoginForm next={next} />
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
