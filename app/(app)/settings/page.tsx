import { Suspense } from 'react';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth/options';
import { GmailPanel } from './GmailPanel';
import { ProfileSlack } from '@/components/settings/ProfileSlack';
import { SnippetsManager } from '@/components/settings/SnippetsManager';
import { SignatureEditor } from '@/components/settings/SignatureEditor';
import { InboxSharing } from '@/components/settings/InboxSharing';
import { PageHeader } from '@/components/ui/PageHeader';
import { Avatar } from '@/components/ui/Avatar';
import { SettingsCard, SettingsGroup, SettingsLayout, SettingsLinkCard, type SettingsSection } from '@/components/settings/SettingsLayout';

const ROLE_LABEL: Record<string, string> = { SUPER_ADMIN: 'Super Admin', ADMIN: 'Admin', OPERATOR: 'Operator', VIEWER: 'Viewer' };

/** Your account: profile, Gmail, signature, saved replies, inbox sharing, and links to the workspace settings. */
export default async function SettingsPage() {
  const session = await getServerSession(authOptions);
  const user = session!.user as { name?: string | null; email?: string | null; role?: string; image?: string | null };
  const superAdmin = user.role === 'SUPER_ADMIN';

  const sections: SettingsSection[] = [
    { id: 'profile', label: 'Profile', icon: 'profile', group: 'You' },
    { id: 'gmail', label: 'Gmail', icon: 'gmail', group: 'You' },
    { id: 'signature', label: 'Email signature', icon: 'signature', group: 'You' },
    { id: 'replies', label: 'Saved replies', icon: 'replies', group: 'Inbox' },
    { id: 'sharing', label: 'Inbox sharing', icon: 'sharing', group: 'Inbox' },
    { id: 'sla', label: 'SLA rules', icon: 'sla', group: 'Workspace' },
    { id: 'webhooks', label: 'Webhooks', icon: 'webhooks', group: 'Workspace' },
    ...(superAdmin ? [{ id: 'server', label: 'Server', icon: 'server', group: 'Workspace' }] : []),
  ];

  return (
    <div className="p-4 sm:p-6">
      <PageHeader eyebrow="Account" title="Settings" description="Your profile, Gmail and inbox preferences, and the workspace's SLA rules, webhooks and server." />

      <SettingsLayout sections={sections}>
        <SettingsGroup label="You">
          <div className="grid gap-4 xl:grid-cols-2">
            <SettingsCard id="profile" icon="profile" title="Profile" description="How you appear in MailFlow, and where your Slack notifications go.">
              <div className="flex items-center gap-3 rounded-xl bg-muted/50 p-3">
                <Avatar email={user.email ?? ''} name={user.name ?? null} size={44} />
                <div className="min-w-0">
                  <div className="truncate font-heading text-sm font-semibold text-foreground">{user.name}</div>
                  <div className="truncate text-xs text-muted-foreground">{user.email}</div>
                </div>
                <span className="badge badge-neutral ml-auto shrink-0">{ROLE_LABEL[user.role ?? ''] ?? user.role}</span>
              </div>
              <div className="mt-4 border-t border-border-subtle pt-4">
                <ProfileSlack />
              </div>
            </SettingsCard>

            <SettingsCard id="gmail" icon="gmail" title="Gmail" description="The mailbox you send from and that MailFlow reads replies from.">
              <Suspense fallback={<div className="text-sm text-muted-foreground">Loading…</div>}>
                <GmailPanel />
              </Suspense>
            </SettingsCard>
          </div>

          <SettingsCard id="signature" icon="signature" title="Email signature" description="Added to campaigns, Quick Sends and replies when you choose to include it.">
            <SignatureEditor />
          </SettingsCard>
        </SettingsGroup>

        <SettingsGroup label="Inbox">
          <div className="grid gap-4 xl:grid-cols-2">
            <SettingsCard id="replies" icon="replies" title="Saved replies" description="Reusable replies for the inbox composer, shared with everyone in this workspace.">
              <SnippetsManager />
            </SettingsCard>
            <SettingsCard id="sharing" icon="sharing" title="Inbox sharing" description="Let teammates see and answer the conversations in your inbox.">
              <InboxSharing />
            </SettingsCard>
          </div>
        </SettingsGroup>

        <SettingsGroup label="Workspace">
          <div className={`grid gap-4 ${superAdmin ? 'md:grid-cols-2 2xl:grid-cols-3' : 'md:grid-cols-2'}`}>
            <SettingsLinkCard id="sla" icon="sla" title="SLA rules" description="Response-time targets. Overdue conversations get a red SLA badge in the inbox." href="/settings/sla" cta="Manage SLA rules" />
            <SettingsLinkCard id="webhooks" icon="webhooks" title="Outbound webhooks" description="HTTPS endpoints that get a POST for workspace events, as they happen." href="/settings/webhooks" cta="Manage webhooks" />
            {superAdmin && (
              <SettingsLinkCard id="server" icon="server" title="Server" description="Whether MailFlow runs on the cloud or your laptop, and switching between them without losing data or sign-ins." href="/settings/server" cta="Manage server" />
            )}
          </div>
        </SettingsGroup>
      </SettingsLayout>
    </div>
  );
}
