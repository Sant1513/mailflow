import { appBaseUrl } from '@/lib/app-url';

/**
 * The Masai logo for emails (an absolute image URL; Gmail shows hosted images). Light version
 * for white headers, `dark` for dark headers (the daily report).
 */
export function masaiLogoUrl(dark = false): string {
  return `${appBaseUrl()}/brand/${dark ? 'masai-logo-dark' : 'masai-logo'}.png`;
}

/** The header of the e-signature emails: the Masai logo on white, "MailFlow · <what>" under it. */
export function emailBrandHeader(subtitle = 'MailFlow · Document signing'): string {
  return `<div style="padding:18px 24px;background:#ffffff;border:1px solid #e5e7eb;border-bottom:none;border-radius:8px 8px 0 0;">
    <img src="${masaiLogoUrl()}" alt="Masai" width="98" height="26" style="display:block;height:26px;width:auto;border:0;" />
    <div style="margin-top:6px;font:600 12px Arial,Helvetica,sans-serif;color:#6b7280;letter-spacing:.03em;">${subtitle}</div>
  </div>`;
}
