import { ActionForm } from '@/components/action-form';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/form';
import { Badge, PageHeader, Table, Td, Th } from '@/components/ui/misc';
import { api } from '@/lib/api';
import type { Invitation, Me, Member, Organization } from '@/lib/types';
import { formatDate } from '@/lib/utils';
import { changeRole, inviteMember, removeMember, revokeInvitation } from '../actions';

export default async function TeamPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const [org, me, { members }] = await Promise.all([
    api<Organization>(`/v1/orgs/${orgId}`),
    api<Me>('/v1/me'),
    api<{ members: Member[] }>(`/v1/orgs/${orgId}/members`),
  ]);
  const canInvite = org.role !== 'viewer';
  const isOwner = org.role === 'owner';
  const { invitations } = canInvite
    ? await api<{ invitations: Invitation[] }>(`/v1/orgs/${orgId}/invitations`)
    : { invitations: [] };

  return (
    <>
      <PageHeader
        title="Team"
        description="Owners manage people and payments. Admins run profiles and connections. Viewers can look."
      />
      <Card>
        <Table>
          <thead>
            <tr>
              <Th>Member</Th>
              <Th>Role</Th>
              <Th>Joined</Th>
              <Th className="text-right">Actions</Th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.userId}>
                <Td>
                  <div className="font-medium">{m.name ?? m.email}</div>
                  {m.name ? <div className="text-xs text-muted-foreground">{m.email}</div> : null}
                </Td>
                <Td>
                  {isOwner && m.userId !== me.user.id ? (
                    <form action={changeRole.bind(null, orgId, m.userId)} className="flex items-center gap-2">
                      <Select
                        name="role"
                        defaultValue={m.role}
                        className="w-28"
                        aria-label={`Role for ${m.email}`}
                      >
                        <option value="owner">Owner</option>
                        <option value="admin">Admin</option>
                        <option value="viewer">Viewer</option>
                      </Select>
                      <Button size="sm" variant="outline" type="submit">
                        Update
                      </Button>
                    </form>
                  ) : (
                    <Badge variant="secondary" className="capitalize">
                      {m.role}
                    </Badge>
                  )}
                </Td>
                <Td className="text-muted-foreground">{formatDate(m.createdAt)}</Td>
                <Td className="text-right">
                  {isOwner && m.userId !== me.user.id ? (
                    <form action={removeMember.bind(null, orgId, m.userId)}>
                      <Button size="sm" variant="ghost" type="submit" className="text-destructive">
                        Remove
                      </Button>
                    </form>
                  ) : null}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>

      {canInvite ? (
        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Invite someone</CardTitle>
              <CardDescription>They’ll get an email with a link that expires in 7 days.</CardDescription>
            </CardHeader>
            <CardContent>
              <ActionForm
                action={inviteMember.bind(null, orgId)}
                submitLabel="Send invitation"
                pendingLabel="Sending…"
                resetOnSuccess
              >
                <Field label="Email" htmlFor="invite-email" name="email">
                  <Input id="invite-email" name="email" type="email" required />
                </Field>
                <Field label="Role" htmlFor="invite-role" name="role">
                  <Select id="invite-role" name="role" defaultValue="viewer">
                    {isOwner ? <option value="owner">Owner</option> : null}
                    <option value="admin">Admin</option>
                    <option value="viewer">Viewer</option>
                  </Select>
                </Field>
              </ActionForm>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Pending invitations</CardTitle>
            </CardHeader>
            <CardContent>
              {invitations.length === 0 ? (
                <p className="text-sm text-muted-foreground">None.</p>
              ) : (
                <ul className="grid gap-2">
                  {invitations.map((i) => (
                    <li key={i.id} className="flex items-center justify-between gap-2 text-sm">
                      <span>
                        {i.email}{' '}
                        <Badge variant="secondary" className="capitalize">
                          {i.role}
                        </Badge>
                      </span>
                      <form action={revokeInvitation.bind(null, orgId, i.id)}>
                        <Button size="sm" variant="ghost" type="submit">
                          Revoke
                        </Button>
                      </form>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      ) : null}
    </>
  );
}
