import { redirect } from 'next/navigation';
import { Logo } from '@/components/logo';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert } from '@/components/ui/misc';
import { ApiError, api } from '@/lib/api';
import type { Me } from '@/lib/types';

export default async function InvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { token } = await params;
  const { error } = await searchParams;
  const me = await api<Me>('/v1/me');

  async function acceptAction() {
    'use server';
    let organizationId: string;
    try {
      ({ organizationId } = await api<{ organizationId: string }>('/v1/invitations/accept', {
        method: 'POST',
        body: { token },
      }));
    } catch (e) {
      if (e instanceof ApiError) redirect(`/invite/${token}?error=${encodeURIComponent(e.message)}`);
      throw e;
    }
    redirect(`/app/${organizationId}`);
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          <Logo />
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Join your team</CardTitle>
            <CardDescription>You’re signed in as {me.user.email}.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {error ? <Alert variant="error">{error}</Alert> : null}
            <form action={acceptAction}>
              <Button type="submit" className="w-full">
                Accept invitation
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
