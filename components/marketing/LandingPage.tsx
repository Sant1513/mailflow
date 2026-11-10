import dynamic from 'next/dynamic';
import {
  ArrowRight,
  Ban,
  ClipboardCheck,
  KeyRound,
  Lock,
  MailCheck,
  ScrollText,
  ShieldCheck,
  UserCog,
  type LucideIcon,
} from 'lucide-react';
import { LoginButton } from '@/app/login/LoginButton';
import { MasaiLogo } from '@/components/brand/MasaiLogo';
import type { PublicStat } from '@/lib/marketing/stats';
import { TopBar } from './TopBar';
import { HeroMock } from './HeroMock';
import { StatsStrip } from './StatsStrip';
import { Reveal } from './Reveal';
import { SectionLink } from './SectionLink';
import type { FaqItem } from './Faq';
import { LeapJourney, LeapUseCases } from './LeapSections';

// Below the fold: split into their own chunks so the hero's JavaScript stays small.
const Features = dynamic(() => import('./Features').then((m) => m.Features));
const Faq = dynamic(() => import('./Faq').then((m) => m.Faq));

function SectionHeading({ eyebrow, title, body, id }: { eyebrow: string; title: React.ReactNode; body?: string; id: string }) {
  return (
    <Reveal className="mx-auto max-w-2xl text-center">
      <div className="eyebrow">{eyebrow}</div>
      <h2 id={id} className="mt-4 font-heading text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
        {title}
      </h2>
      {body && <p className="mt-4 text-base leading-relaxed text-muted-foreground">{body}</p>}
    </Reveal>
  );
}

/* ---------- Deep-dives ---------- */

const TRUST: { icon: LucideIcon; title: string; body: string }[] = [
  { icon: MailCheck, title: 'Your own Gmail', body: 'Emails go from the sender’s own mailbox, so replies come back to a real person. Never a "noreply".' },
  { icon: KeyRound, title: 'Encrypted tokens', body: 'Gmail access tokens are encrypted at rest with AES-256-GCM and never sent to the browser.' },
  { icon: ClipboardCheck, title: 'Approval before sending', body: 'Campaigns need an admin’s sign-off; Quick Sends from non-admins wait in Approvals.' },
  { icon: ScrollText, title: 'Audit log', body: 'Sensitive actions are recorded, with filters to find who did what and when.' },
  { icon: Ban, title: 'One-click unsubscribe', body: 'Every bulk email carries an Unsubscribe button and one-click List-Unsubscribe headers.' },
  { icon: ShieldCheck, title: 'Org-wide bounce suppression', body: 'An address that bounced once is skipped by everyone, before the next send.' },
  { icon: UserCog, title: 'Roles and sign-in approval', body: 'Viewer, Operator, Admin and Super Admin. New people wait for a Super Admin to approve them.' },
];

function faqItems(domains: string | null): FaqItem[] {
  return [
    {
      q: 'How many emails can I send?',
      a: 'Each connected mailbox sends one email every 3 seconds and stops at 1,500 emails in any rolling 24 hours, safely under Google Workspace’s limit of 2,000. If a mailbox reaches its limit or Gmail asks it to slow down, it pauses and backup mailboxes you picked carry on; it resumes by itself once it can send again.',
    },
    {
      q: 'Which Gmail address do emails come from?',
      a: 'Your own. You connect the Google account you already use, and emails go out from it, so they sit in your Sent folder and replies come back to you (and into MailFlow’s shared inbox). There is no shared "noreply" address.',
    },
    {
      q: 'What happens to our data?',
      a: 'Your data stays in MailFlow’s own database and is only used to send the emails and documents you ask for. Gmail access tokens are encrypted at rest (AES-256-GCM) and never reach the browser, actions are recorded in an audit log, and roles decide who can see and do what.',
    },
    {
      q: 'Who can sign in?',
      a: `${domains ? `Only Google accounts from ${domains} can sign in. ` : ''}Anyone new waits until a Super Admin approves them, and then works with the role they are given: Viewer, Operator, Admin or Super Admin.`,
    },
    {
      q: 'What does it cost the team?',
      a: 'Nothing extra. MailFlow is Masai’s internal tool and sends through the Google accounts the team already has, so there is no per-email or per-seat charge to worry about.',
    },
  ];
}

/* ---------- Page ---------- */

export function LandingPage({ stats, domains }: { stats: PublicStat[]; domains: string | null }) {
  const year = new Date().getFullYear();
  return (
    <div id="top" className="relative min-h-screen overflow-x-clip bg-background">
      <a href="#main" className="sr-only z-50 rounded-full bg-card px-4 py-2 text-sm text-foreground focus:not-sr-only focus:fixed focus:left-4 focus:top-4">
        Skip to content
      </a>
      {/* Red wash top-left, as on masaischool.com */}
      <div aria-hidden className="pointer-events-none absolute -left-40 -top-40 h-[32rem] w-[32rem] rounded-full bg-primary/20 blur-[120px]" />

      <TopBar />

      <main id="main">
        {/* 2. Hero: text and CTA are rendered visible (no entrance animation on the LCP text) */}
        <section aria-labelledby="hero-title" className="relative px-4 pb-16 pt-12 sm:px-6 sm:pt-16 lg:pb-24 lg:pt-20">
          <div className="mx-auto grid max-w-6xl items-center gap-12 lg:grid-cols-[1.1fr_1fr] lg:gap-10">
            <div className="min-w-0">
              <div className="eyebrow">MailFlow Mail &amp; MailFlow Sign</div>
              <h1 id="hero-title" className="mt-5 font-heading text-[2.5rem] font-bold leading-[1.05] tracking-tight text-foreground sm:text-5xl lg:text-6xl">
                Every email to every batch, <span className="accent">sent from your Gmail.</span>
              </h1>
              <p className="mt-5 max-w-xl text-base text-muted-foreground sm:text-lg">
                Campaigns, a shared inbox and e-signatures for the Masai team, on your own data, with nothing going out until you have checked it.
              </p>
              <div id="sign-in" className="mt-8 flex scroll-mt-28 flex-col gap-3 sm:flex-row sm:items-center">
                <div className="sm:w-64">
                  <LoginButton />
                </div>
                <SectionLink to="how-it-works" className="btn-secondary !py-3">
                  See how it works <ArrowRight size={15} aria-hidden />
                </SectionLink>
              </div>
              {domains && (
                <p className="mt-3 flex items-center gap-1.5 text-xs text-faint">
                  <Lock size={12} aria-hidden /> For {domains} accounts. New people are approved by an admin.
                </p>
              )}
              <StatsStrip stats={stats} />
            </div>
            <div className="min-w-0">
              <HeroMock />
            </div>
          </div>
        </section>

        {/* 3–4. Mail | Sign switcher and feature bento */}
        <section id="features" aria-labelledby="features-title" className="scroll-mt-24 px-4 py-20 sm:px-6">
          <div className="mx-auto max-w-6xl">
            <SectionHeading
              id="features-title"
              eyebrow="Features"
              title={
                <>
                  Two products, <span className="accent">one place.</span>
                </>
              }
              body="Mail for campaigns, bulk sends and the replies that follow. Sign for agreements, from one document to a whole batch."
            />
            <div className="mt-10">
              <Features />
            </div>
          </div>
        </section>

        {/* 5–6. The journey: six stops, with sticky rail (Leap style) */}
        <LeapJourney />

        {/* 7. Trust & security */}
        <section id="security" aria-labelledby="security-title" className="scroll-mt-24 border-y border-border-subtle bg-card/40 px-4 py-20 sm:px-6">
          <div className="mx-auto max-w-6xl">
            <SectionHeading
              id="security-title"
              eyebrow="Trust & security"
              title={
                <>
                  Built so a big send is <span className="accent">a safe send.</span>
                </>
              }
              body="The checks are part of the product, not a policy document."
            />
            <ul className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {TRUST.map((item, i) => {
                const Icon = item.icon;
                return (
                  <Reveal as="li" key={item.title} index={i % 4} className={i === TRUST.length - 1 ? 'sm:col-span-2 lg:col-span-1' : ''}>
                    <div className="h-full rounded-[var(--radius-card)] border border-border-subtle bg-card p-5 dark:bg-transparent">
                      <Icon size={20} aria-hidden className="text-primary" />
                      <h3 className="mt-3 font-heading text-[15px] font-semibold text-foreground">{item.title}</h3>
                      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{item.body}</p>
                    </div>
                  </Reveal>
                );
              })}
            </ul>
          </div>
        </section>

        {/* 8. Use cases (Leap style) */}
        <LeapUseCases />

        {/* 9. FAQ */}
        <section id="faq" aria-labelledby="faq-title" className="scroll-mt-24 px-4 pb-20 sm:px-6">
          <div className="mx-auto max-w-3xl">
            <SectionHeading id="faq-title" eyebrow="FAQ" title="Questions, answered." />
            <div className="mt-10">
              <Faq items={faqItems(domains)} />
            </div>
          </div>
        </section>

        {/* 10. Final CTA */}
        <section aria-labelledby="cta-title" className="px-4 pb-20 sm:px-6">
          <Reveal className="relative mx-auto max-w-6xl overflow-hidden rounded-[28px] bg-[hsl(240_10%_7%)] px-6 py-14 text-center sm:px-12">
            <div aria-hidden className="pointer-events-none absolute -right-24 -top-24 h-80 w-80 rounded-full bg-primary/40 blur-[100px]" />
            <div aria-hidden className="pointer-events-none absolute -bottom-32 -left-16 h-72 w-72 rounded-full bg-[hsl(20_95%_55%/0.25)] blur-[100px]" />
            <h2 id="cta-title" className="relative font-heading text-3xl font-bold tracking-tight text-white sm:text-4xl">
              Your next batch is one sign-in away.
            </h2>
            <p className="relative mx-auto mt-4 max-w-xl text-base text-white/70">
              Connect the Gmail you already use, bring your sheet, and run a dry run before anything goes out.
            </p>
            <div className="relative mx-auto mt-8 max-w-xs [&_.btn-primary]:!bg-white [&_.btn-primary]:!text-[hsl(240_10%_7%)]">
              <LoginButton />
            </div>
            {domains && <p className="relative mt-4 text-xs text-white/55">For {domains} accounts.</p>}
          </Reveal>
        </section>
      </main>

      <footer className="border-t border-border-subtle px-4 py-10 sm:px-6">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2.5">
            <MasaiLogo height={22} />
            <span aria-hidden className="h-5 w-px bg-border" />
            <span className="font-heading text-sm font-semibold text-foreground">MailFlow</span>
          </div>
          <nav aria-label="Footer">
            <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted-foreground">
              <li>
                <SectionLink to="features" className="hover:text-foreground">Features</SectionLink>
              </li>
              <li>
                <SectionLink to="security" className="hover:text-foreground">Security</SectionLink>
              </li>
              <li>
                <SectionLink to="faq" className="hover:text-foreground">FAQ</SectionLink>
              </li>
              <li>
                <a href="https://www.masaischool.com" className="hover:text-foreground" rel="noopener">
                  masaischool.com
                </a>
              </li>
            </ul>
          </nav>
          <p className="text-xs text-faint">© {year} Masai School · Internal tool</p>
        </div>
      </footer>
    </div>
  );
}
