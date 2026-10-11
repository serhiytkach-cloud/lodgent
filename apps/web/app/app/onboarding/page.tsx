import { Logo } from '@/components/logo';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { OnboardingForm } from './onboarding-form';

export default function OnboardingPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted px-4 py-10">
      <div className="w-full max-w-lg">
        <div className="mb-6 flex justify-center">
          <Logo />
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Set up your hotel group</CardTitle>
            <CardDescription>
              Next you’ll connect your Apaleo PMS and Stripe, review the profile AI agents will see, and
              publish.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <OnboardingForm />
          </CardContent>
        </Card>
        <ol className="mt-6 grid gap-2 text-sm text-muted-foreground">
          <li>1. Create your organization</li>
          <li>2. Connect Apaleo and Stripe</li>
          <li>3. Review and approve your attribute profile</li>
          <li>4. Publish to AI agents</li>
        </ol>
      </div>
    </main>
  );
}
