import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, Badge } from '@/components/ui/misc';
import { api } from '@/lib/api';
import type { Organization } from '@/lib/types';
import { CopyButton, PublishButton } from './publish-controls';

interface Readiness {
  status: 'draft' | 'published' | 'unpublished';
  canPublish: boolean;
  checks: { key: string; label: string; ok: boolean; required: boolean; message: string }[];
  completeness: number;
  profileUrl: string;
  jsonLd: Record<string, unknown>;
}

export default async function PublishPage({
  params,
}: {
  params: Promise<{ orgId: string; propertyId: string }>;
}) {
  const { orgId, propertyId } = await params;
  const [org, readiness] = await Promise.all([
    api<Organization>(`/v1/orgs/${orgId}`),
    api<Readiness>(`/v1/orgs/${orgId}/properties/${propertyId}/publish`),
  ]);
  const canManage = org.role !== 'viewer';
  const published = readiness.status === 'published';
  const snippet = `<script type="application/ld+json">\n${JSON.stringify(readiness.jsonLd, null, 2).replace(/</g, '\\u003c')}\n</script>`;

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {published ? 'Live for AI agents' : 'Publish to AI agents'}
            {published ? <Badge variant="success">Published</Badge> : null}
          </CardTitle>
          <CardDescription>
            Published hotels appear in agent searches with live rates from Apaleo. You can unpublish at any
            time.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <ul className="grid gap-2">
            {readiness.checks.map((c) => (
              <li key={c.key} className="flex items-start gap-3 text-sm">
                <span
                  aria-hidden
                  className={
                    c.ok
                      ? 'mt-0.5 grid size-5 place-items-center rounded-full bg-success/15 text-xs text-success'
                      : c.required
                        ? 'mt-0.5 grid size-5 place-items-center rounded-full bg-destructive/10 text-xs text-destructive'
                        : 'mt-0.5 grid size-5 place-items-center rounded-full bg-muted text-xs text-muted-foreground'
                  }
                >
                  {c.ok ? '✓' : c.required ? '✕' : '–'}
                </span>
                <span>
                  <span className="font-medium">{c.label}</span>
                  <span className="sr-only">
                    {c.ok ? ' (done)' : c.required ? ' (required)' : ' (optional)'}
                  </span>
                  {!c.ok ? <span className="block text-muted-foreground">{c.message}</span> : null}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-sm text-muted-foreground">Profile completeness: {readiness.completeness}%</p>
          {canManage ? (
            <PublishButton
              orgId={orgId}
              propertyId={propertyId}
              published={published}
              canPublish={readiness.canPublish}
            />
          ) : (
            <Alert variant="info">Ask an owner or admin to publish.</Alert>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Public profile</CardTitle>
          <CardDescription>
            A page agents and search engines can read, with your approved facts only.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3 text-sm">
          {published ? (
            <a
              href={readiness.profileUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2"
            >
              {readiness.profileUrl}
            </a>
          ) : (
            <span className="text-muted-foreground">{readiness.profileUrl} (available once published)</span>
          )}
          <CopyButton text={readiness.profileUrl} label="Copy link" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Structured data for your website</CardTitle>
          <CardDescription>
            Paste this into the &lt;head&gt; of your homepage. It describes your hotel, rooms and amenities in
            schema.org terms that search engines and AI assistants understand. Update it when your profile
            changes.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div>
            <CopyButton text={snippet} label="Copy snippet" />
          </div>
          <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs leading-relaxed">
            <code>{snippet}</code>
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}
