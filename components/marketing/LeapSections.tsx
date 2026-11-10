import dynamic from 'next/dynamic';
import { Briefcase, FileSignature, GraduationCap, Users, type LucideIcon } from 'lucide-react';
import { leapMono, leapSans } from './fonts';
import { LEAP_JS_SCRIPT, RevealObserver } from './LeapMotion';
import './leap.css';

/*
 * The two sections kept from the Leap-style redesign, dropped into the original landing page:
 * the sticky "Six stops" journey and the "What the team uses it for" cards. Each sits in its
 * own .leap-ui.leap-embed wrapper (Leap fonts, rules and reveals; MailFlow's own colours).
 */

const Journey = dynamic(() => import('./Journey').then((m) => m.Journey));

/** Reveal delay for the n-th item in a row: 35 ms apart, capped at 175 ms. */
const d = (i: number) => ({ ['--d' as string]: `${Math.min(i * 35, 175)}ms` }) as React.CSSProperties;

function SectionHead({ kicker, id, children }: { kicker: string; id: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="kick kick-rule" data-r="">
        {kicker}
      </div>
      <h2 id={id} className="h2" data-r="" style={d(1)}>
        {children}
      </h2>
    </div>
  );
}

function Embed({ children }: { children: React.ReactNode }) {
  return (
    <div className={`${leapSans.variable} ${leapMono.variable}`}>
      <div className="leap-ui leap-embed">{children}</div>
    </div>
  );
}

/** Six stops, one sent batch: the sticky journey (replaces "How it works" and the deep-dives). */
export function LeapJourney() {
  return (
    <Embed>
      {/* Hides [data-r] until it scrolls in, only where IntersectionObserver exists. */}
      <script dangerouslySetInnerHTML={{ __html: LEAP_JS_SCRIPT }} />
      <section id="how-it-works" aria-labelledby="flow-title" className="section">
        <div className="wrap">
          <SectionHead kicker="The MailFlow flow" id="flow-title">
            Six stops. <span className="coral">One sent batch.</span>
          </SectionHead>
          <Journey />
        </div>
      </section>
      <RevealObserver />
    </Embed>
  );
}

const USE_CASES: { icon: LucideIcon; kick: string; title: string; body: string }[] = [
  { icon: GraduationCap, kick: 'Placements', title: 'Placement drives', body: 'Invite a batch with RSVP buttons, then follow up with everyone who has not answered.' },
  { icon: Briefcase, kick: 'Hiring partners', title: 'Recruiter outreach', body: 'A personal email to each recruiter from your own columns, spread across every mailbox.' },
  { icon: Users, kick: 'Admissions', title: 'Admissions follow-ups', body: 'Follow-ups from your sheet, with every reply threaded and assigned to an owner.' },
  { icon: FileSignature, kick: 'Agreements', title: 'Offer letters & agreements', body: 'Send a whole cohort its documents to sign, and see the status back in your data.' },
];

/** What the team uses it for: four cards with mono kickers. */
export function LeapUseCases() {
  return (
    <Embed>
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
    </Embed>
  );
}
