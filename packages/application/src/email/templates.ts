import { BRAND } from '@lodgent/shared';
import { z } from 'zod';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function layout(title: string, bodyHtml: string, accent = '#1d4ed8'): string {
  return `<!doctype html><html><body style="margin:0;background:#f5f5f4;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1c1917">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px">
<table role="presentation" width="100%" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="background:${accent};height:6px"></td></tr>
<tr><td style="padding:28px">
<h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(title)}</h1>
${bodyHtml}
</td></tr></table>
<p style="font-size:12px;color:#78716c;margin-top:16px">Sent by ${escapeHtml(BRAND.name)}</p>
</td></tr></table></body></html>`;
}

function button(href: string, label: string, accent = '#1d4ed8'): string {
  return `<p style="margin:24px 0"><a href="${escapeHtml(href)}" style="background:${accent};color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:600">${escapeHtml(label)}</a></p>`;
}

export const InvitationEmailData = z.object({
  organizationName: z.string(),
  inviterEmail: z.string().nullable(),
  role: z.string(),
  link: z.url(),
});

export function invitationEmail(data: z.infer<typeof InvitationEmailData>) {
  const subject = `You're invited to ${data.organizationName} on ${BRAND.name}`;
  const who = data.inviterEmail ? `${data.inviterEmail} invited you` : 'You have been invited';
  const html = layout(
    subject,
    `<p>${escapeHtml(who)} to join <strong>${escapeHtml(data.organizationName)}</strong> as ${escapeHtml(data.role)}.</p>
${button(data.link, 'Accept invitation')}
<p style="font-size:13px;color:#57534e">The link expires in 7 days. If you weren't expecting this, you can ignore this email.</p>`,
  );
  const text = `${who} to join ${data.organizationName} as ${data.role}.\n\nAccept: ${data.link}\n\nThe link expires in 7 days.`;
  return { subject, html, text };
}

export const EMAIL_TEMPLATES = {
  invitation: { schema: InvitationEmailData, render: invitationEmail },
} as const;

export type EmailTemplateName = keyof typeof EMAIL_TEMPLATES;

export function renderEmail(template: string, data: unknown) {
  const entry = EMAIL_TEMPLATES[template as EmailTemplateName];
  if (!entry) throw new Error(`Unknown email template: ${template}`);
  // Each template validates its own data before rendering.
  return (entry.render as (d: unknown) => { subject: string; html: string; text: string })(
    entry.schema.parse(data),
  );
}
