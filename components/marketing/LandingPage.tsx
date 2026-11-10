import dynamic from 'next/dynamic';
import { Briefcase, FileSignature, GraduationCap, Users, type LucideIcon } from 'lucide-react';
import { BrandLockup } from './BrandLockup';
import type { PublicStat } from '@/lib/marketing/stats';
import { leapMono, leapSans } from './fonts';
import { Nav } from './Nav';
import { GoogleCta } from './GoogleCta';
import { HeroMock } from './HeroMock';
import { HeroStats, LiveCount } from './StatsStrip';
import { CtaBar, LEAP_JS_SCRIPT, RevealObserver } from './LeapMotion';
import type { FaqGroup } from './Faq';
import './leap.css';

// Below the fold: their own chunks, so the hero's JavaScript stays small.
const Features = dynamic(() => import('./Features').then((m) => m.Features));
const Journey = dynamic(() => import('./Journey').then((m) => m.Journey));
const Faq = dynamic(() => import('./Faq').then((m) => m.Faq));

/** Reveal delay for the n-th item in a row: 35 ms apart, capped at 175 ms (Leap's stagger). */
const d = (i: number) => ({ ['--d' as string]: `${Math.min(i * 35, 175)}ms` }) as React.CSSProperties;

function SectionHead({ kicker, id, children, lede }: { kicker: string; id: string; children: React.ReactNode; lede?: string }) {
  return (
    <div>
      <div className="kick kick-rule" data-r="">
        {kicker}
      </div>
      <h2 id={id} className="h2" data-r="" style={d(1)}>
        {children}
      </h2>
      {lede && (
        <p className="lede" data-r="" style={d(2)}>
          {lede}
        </p>
      )}
    </div>
  );
}

/* ---------- Always / Never (each line checked against the code) ---------- */

const ALWAYS = [
  'Sends from your own Gmail address',
  'Holds a campaign from a non-admin until an admin approves it',
  'Threads every reply, bounce and out-of-office back to its record',
  'Adds an Unsubscribe button to every bulk email',
  'Keeps an audit log of sensitive actions',
  'Encrypts Google tokens at rest (AES-256-GCM)',
];
const NEVER = [
  'Uses a shared "noreply" address',
  'Emails someone who unsubscribed or bounced before',
  'Sends anyone a duplicate by accident: each email is claimed before it goes',
  'Sees or stores your Google password',
  'Lets a new account in before a Super Admin approves it',
];

function Check() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden fill="none" stroke="var(--accent-hi)" strokeWidth="1.6">
      <path d="M2.5 7.5l3 3 6-7" />
    </svg>
  );
}
function Cross() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden fill="none" stroke="var(--on-deep-mu)" strokeWidth="1.1">
      <circle cx="7" cy="7" r="6" />
      <path d="M4.8 4.8l4.4 4.4M9.2 4.8l-4.4 4.4" />
    </svg>
  );
}

/* ---------- Use cases ---------- */

const USE_CASES: { icon: LucideIcon; kick: string; title: string; body: string }[] = [
  { icon: GraduationCap, kick: 'Placements', title: 'Placement drives', body: 'Invite a batch with RSVP buttons, then follow up with everyone who has not answered.' },
  { icon: Briefcase, kick: 'Hiring partners', title: 'Recruiter outreach', body: 'A personal email to each recruiter from your own columns, spread across every mailbox.' },
  { icon: Users, kick: 'Admissions', title: 'Admissions follow-ups', body: 'Follow-ups from your sheet, with every reply threaded and assigned to an owner.' },
  { icon: FileSignature, kick: 'Agreements', title: 'Offer letters & agreements', body: 'Send a whole cohort its documents to sign, and see the status back in your data.' },
];

/* ---------- FAQ ---------- */

function faqGroups(domains: string | null): FaqGroup[] {
  return [
    {
      id: 'sending',
      label: 'Sending',
      items: [
        {
          q: 'How many emails can I send?',
          a: 'Each connected mailbox sends one email every 3 seconds and stops at 1,500 emails in any rolling 24 hours, safely under Google Workspace’s 2,000. If a mailbox reaches its limit or Gmail asks it to slow down, it pauses and the backup mailboxes you picked carry on; it resumes by itself once it can send again.',
        },
        {
          q: 'Which Gmail address do emails come from?',
          a: 'Your own. You connect the Google account you already use, emails go out from it and sit in your Sent folder, and replies come back to you and into MailFlow’s shared inbox. There is no shared "noreply" address.',
        },
        {
          q: 'Can I check a send before it goes out?',
          a: 'Yes. Preview each personalised email, run a dry run that shows who receives what and who is skipped and why, and send yourself a test. Campaigns from non-admins wait in Approvals until an admin approves them.',
        },
        {
          q: 'What happens when someone unsubscribes or an email bounces?',
          a: 'Every bulk email has an Unsubscribe button. Unsubscribed and previously bounced addresses are skipped on later sends, and a bounce is suppressed across the whole organisation, not just your campaign.',
        },
      ],
    },
    {
      id: 'data',
      label: 'Data & privacy',
      items: [
        {
          q: 'What happens to our data?',
          a: 'Your data stays in MailFlow’s own database and is used to send the emails and documents you ask for. Gmail access tokens are encrypted at rest (AES-256-GCM) and never reach the browser, sensitive actions are recorded in an audit log, and roles decide who can see and do what.',
        },
        {
          q: 'Does MailFlow see my Google password?',
          a: 'No. You sign in with Google, so your password is only ever typed into Google. MailFlow keeps the access Google grants it, encrypted.',
        },
      ],
    },
    {
      id: 'access',
      label: 'Access',
      items: [
        {
          q: 'Who can sign in?',
          a: `${domains ? `Only Google accounts from ${domains}. ` : ''}Anyone new waits until a Super Admin approves them, and then works with the role they are given: Viewer, Operator, Admin or Super Admin.`,
        },
        {
          q: 'What does it cost the team?',
          a: 'Nothing extra. MailFlow is Masai’s internal tool and sends through the Google accounts the team already has, so there is no per-email or per-seat charge.',
        },
      ],
    },
    {
      id: 'inbox',
      label: 'Inbox',
      items: [
        {
          q: 'Where do replies go?',
          a: 'Into one shared inbox, threaded to the campaign and record they came from, whether it is a reply, a bounce or an out-of-office. Conversations can be assigned, tagged and noted, and SLA timers flag what is overdue.',
        },
        {
          q: 'Does the AI reply on its own?',
          a: 'No. AI triage sorts human replies and drafts an answer, and nothing is sent until someone approves it. It can be switched off for the organisation.',
        },
      ],
    },
    {
      id: 'sign',
      label: 'Sign',
      items: [
        {
          q: 'How many people can sign one document?',
          a: 'Up to 3 signers per document, signing in order (1 → 2 → 3) or in parallel. Automatic reminders go out until they have signed.',
        },
        {
          q: 'Can we use our existing Word templates?',
          a: 'Yes. Upload a .docx or paste a Google Doc link shared as "Anyone with the link"; {{fields}} are found automatically and the formatting is kept.',
        },
        {
          q: 'What do signers get at the end?',
          a: 'A signed PDF with a certificate of completion. Documents with several signers also produce a combined PDF that is emailed to every signer, and the status is written back to the row it was sent from.',
        },
      ],
    },
  ];
}

/* ---------- Page ---------- */

export function LandingPage({ stats, domains }: { stats: PublicStat[]; domains: string | null }) {
  const year = new Date().getFullYear();
  const byKey = (k: PublicStat['key']) => stats.find((s) => s.key === k);
  const emails = byKey('emailsSent');
  const livePill = byKey('mailboxesConnected') ?? emails;

  const announcements = [
    'Sends from your own Gmail',
    'Every reply threaded back to the record',
    'Bulk e-signature built in',
    '8 PM daily report in email and Slack',
    ...(domains ? [`For ${domains} teams`] : []),
    ...(emails ? [`${emails.display} emails sent`] : []),
    'A dry run before you send',
  ];

  return (
    // Always dark: `dark` here re-points the app's tokens for the shared components inside.
    <div className={`dark ${leapSans.variable} ${leapMono.variable}`}>
      <div className="leap-ui">
        <script dangerouslySetInnerHTML={{ __html: LEAP_JS_SCRIPT }} />
        <a href="#main" className="skip">
          Skip to content
        </a>
        <Nav announcements={announcements} />

        <main id="main">
          {/* Hero: headline and CTA are not animated (they are the first paint). */}
          <section id="top" aria-labelledby="hero-title" className="hero">
            <div aria-hidden className="hero-glow" />
            <div className="wrap">
              <div className="kick hero-kick">
                <span className="dot" aria-hidden /> MailFlow Mail · MailFlow Sign
              </div>
              <h1 id="hero-title" className="h1">
                Every email to every batch, <span className="coral">sent from your Gmail.</span>
              </h1>
              <p className="steps">
                <span>
                  Bring your <b>data</b>
                </span>
                <span aria-hidden className="rule" />
                <span>
                  <b>Dry run</b> &amp; approve
                </span>
                <span aria-hidden className="rule" />
                <span>
                  Send &amp; track <b>replies</b>
                </span>
              </p>
              <div className="hero-ctas">
                <GoogleCta cta />
                {livePill && (
                  <span className="live-pill">
                    <span className="dot" aria-hidden />
                    <LiveCount stat={livePill} />
                    {livePill.label}
                  </span>
                )}
              </div>
              {domains && <p className="hero-note">For {domains} accounts. New people are approved by a Super Admin.</p>}
              <HeroStats stats={stats} />
              <div className="hero-window" data-r="s">
                <HeroMock />
              </div>
            </div>
          </section>

          {/* Feature bento with the Mail | Sign switcher */}
          <section id="features" aria-labelledby="features-title" className="section inv">
            <span id="mail" className="sr-only" />
            <span id="sign" className="sr-only" />
            <div className="wrap">
              <SectionHead kicker="Two products" id="features-title" lede="Mail for campaigns, bulk sends and the replies that follow. Sign for agreements, from one document to a whole batch.">
                Everything the team sends, <span className="coral">in one place.</span>
              </SectionHead>
              <div className="mt-10">
                <Features />
              </div>
            </div>
          </section>

          {/* The journey */}
          <section id="how-it-works" aria-labelledby="flow-title" className="section">
            <div className="wrap">
              <SectionHead kicker="The MailFlow flow" id="flow-title">
                Six stops. <span className="coral">One sent batch.</span>
              </SectionHead>
              <Journey />
            </div>
          </section>

          {/* Trust & security: always / never */}
          <section id="security" aria-labelledby="security-title" className="section inv">
            <div className="wrap">
              <SectionHead kicker="Trust & security" id="security-title" lede="The checks are built into the product, not written in a policy document.">
                A big send should be <span className="coral">a safe send.</span>
              </SectionHead>
              <div className="card mt-10" data-r="s">
                <h3 className="!mt-0 !text-[1.5rem]">What MailFlow does, every time.</h3>
                <div className="an-grid">
                  <div className="an-always">
                    <div className="an-head">Always</div>
                    <ul className="an-list">
                      {ALWAYS.map((a) => (
                        <li key={a}>
                          <Check />
                          {a}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="an-never">
                    <div className="an-head">Never</div>
                    <ul className="an-list">
                      {NEVER.map((n) => (
                        <li key={n}>
                          <Cross />
                          {n}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
              <p className="foot-note mt-5">Roles: Viewer · Operator · Admin · Super Admin</p>
            </div>
          </section>

          {/* Use cases */}
          <section aria-labelledby="uses-title" className="section">
            <div className="wrap">
              <SectionHead kicker="Use cases" id="uses-title">
                What the team <span className="coral">uses it for.</span>
              </SectionHead>
              <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {USE_CASES.map((u, i) => {
                  const Icon = u.icon;
                  return (
                    <li key={u.title} data-r="" style={d(i)} className="card card-hover flex flex-col">
                      <div className="flex items-center justify-between">
                        <span className="card-kick">{u.kick}</span>
                        <Icon size={18} aria-hidden className="text-[var(--on-deep-mu)]" />
                      </div>
                      <h3>{u.title}</h3>
                      <p>{u.body}</p>
                    </li>
                  );
                })}
              </ul>
            </div>
          </section>

          {/* Closing band */}
          <section aria-labelledby="cta-title" className="closing">
            <div className="wrap">
              <h2 id="cta-title" data-r="">
                Your next batch is one sign-in away.
              </h2>
              <p className="lede mx-auto" data-r="" style={d(1)}>
                Connect the Gmail you already use, bring your sheet, and run a dry run before anything goes out.
              </p>
              <div className="mt-8 flex justify-center" data-r="" style={d(2)}>
                <GoogleCta cta />
              </div>
              {domains && (
                <p className="mt-4 text-[0.8125rem] text-[var(--on-deep-mu)]">
                  <b className="text-[var(--paper)]">For {domains} accounts.</b> New accounts are approved by a Super Admin.
                </p>
              )}
            </div>
          </section>

          {/* FAQ */}
          <section id="faq" aria-labelledby="faq-title" className="section !pt-8">
            <div className="wrap">
              <SectionHead kicker="FAQ's" id="faq-title">
                Straight answers.
              </SectionHead>
              <div className="mt-10">
                <Faq groups={faqGroups(domains)} />
              </div>
            </div>
          </section>
        </main>

        <footer className="footer">
          <div className="wrap">
            <div className="flex flex-col gap-10 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <a href="#top" className="brand" aria-label="MailFlow by Masai, back to top">
                  <BrandLockup size="footer" />
                </a>
                <p className="foot-note mt-4">Mail · Sign · Internal tool</p>
              </div>
              <nav aria-label="Footer" className="grid grid-cols-2 gap-x-14 gap-y-2 text-[0.9375rem]">
                <div>
                  <div className="foot-note mb-3">This product</div>
                  <ul className="grid gap-2 text-[var(--paper)]">
                    <li><a href="#mail" className="hover:text-[var(--coral)]">Mail</a></li>
                    <li><a href="#sign" className="hover:text-[var(--coral)]">Sign</a></li>
                    <li><a href="#how-it-works" className="hover:text-[var(--coral)]">How it works</a></li>
                    <li><a href="#security" className="hover:text-[var(--coral)]">Security</a></li>
                    <li><a href="#faq" className="hover:text-[var(--coral)]">FAQ</a></li>
                  </ul>
                </div>
                <div>
                  <div className="foot-note mb-3">Masai</div>
                  <ul className="grid gap-2 text-[var(--paper)]">
                    <li><a href="https://www.masaischool.com" rel="noopener" className="hover:text-[var(--coral)]">masaischool.com</a></li>
                  </ul>
                </div>
              </nav>
            </div>
            <div className="mt-10 border-t border-[var(--deep-rule)] pt-6 text-[0.8125rem] text-[var(--on-deep-mu)]">© {year} Masai School · MailFlow is an internal tool</div>
          </div>
        </footer>

        <CtaBar />
        <RevealObserver />
      </div>
    </div>
  );
}
