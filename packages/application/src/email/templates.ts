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

export const BookingConfirmationData = z.object({
  hotelName: z.string(),
  hotelAddress: z.string().nullable(),
  hotelEmail: z.string().nullable(),
  hotelPhone: z.string().nullable(),
  accentColor: z.string().nullable(),
  guestName: z.string(),
  reference: z.string(),
  confirmationNumber: z.string(),
  checkIn: z.string(),
  checkOut: z.string(),
  checkInTime: z.string().nullable(),
  checkOutTime: z.string().nullable(),
  guests: z.string(),
  roomType: z.string(),
  ratePlan: z.string(),
  total: z.string(),
  payment: z.string(),
  cancellation: z.string(),
  link: z.url(),
});

export function bookingConfirmationEmail(data: z.infer<typeof BookingConfirmationData>) {
  const accent = data.accentColor && /^#[0-9a-f]{6}$/i.test(data.accentColor) ? data.accentColor : '#1d4ed8';
  const subject = `Booking confirmed: ${data.hotelName}, ${data.checkIn}`;
  const rows: [string, string][] = [
    ['Confirmation number', data.confirmationNumber],
    ['Check-in', `${data.checkIn}${data.checkInTime ? ` from ${data.checkInTime}` : ''}`],
    ['Check-out', `${data.checkOut}${data.checkOutTime ? ` until ${data.checkOutTime}` : ''}`],
    ['Guests', data.guests],
    ['Room', `${data.roomType} · ${data.ratePlan}`],
    ['Total', data.total],
    ['Payment', data.payment],
    ['Cancellation', data.cancellation],
  ];
  const table = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 12px 6px 0;color:#57534e;vertical-align:top;white-space:nowrap">${escapeHtml(k)}</td><td style="padding:6px 0">${escapeHtml(v)}</td></tr>`,
    )
    .join('');
  const contact = [data.hotelAddress, data.hotelEmail, data.hotelPhone]
    .filter(Boolean)
    .map((v) => escapeHtml(v!));
  const html = layout(
    subject,
    `<p>Dear ${escapeHtml(data.guestName)}, your stay at <strong>${escapeHtml(data.hotelName)}</strong> is confirmed.</p>
<table role="presentation" style="font-size:14px;border-collapse:collapse;margin:16px 0">${table}</table>
${button(data.link, 'View booking', accent)}
<p style="font-size:13px;color:#57534e">${contact.join('<br>')}</p>
<p style="font-size:12px;color:#78716c">Reference ${escapeHtml(data.reference)}. To change or cancel, contact the hotel directly.</p>`,
    accent,
  );
  const text = [
    `Dear ${data.guestName}, your stay at ${data.hotelName} is confirmed.`,
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    `View booking: ${data.link}`,
    contact.length > 0
      ? `\nHotel: ${[data.hotelAddress, data.hotelEmail, data.hotelPhone].filter(Boolean).join(', ')}`
      : '',
    `Reference ${data.reference}. To change or cancel, contact the hotel directly.`,
  ].join('\n');
  return { subject, html, text };
}

export const EMAIL_TEMPLATES = {
  invitation: { schema: InvitationEmailData, render: invitationEmail },
  'booking-confirmation': { schema: BookingConfirmationData, render: bookingConfirmationEmail },
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
