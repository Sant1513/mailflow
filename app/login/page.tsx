import { LoginButton } from './LoginButton';
import { allowedDomain } from '@/lib/auth/options';

const PILLARS = [
  { title: 'Campaigns', body: 'Personalised sends to any batch, with dry runs and approvals before anything goes out.' },
  { title: 'Automations', body: 'Trigger follow-ups from your own data — stop the moment someone replies.' },
  { title: 'Inbox', body: 'Every reply, bounce and out-of-office threaded back to the record it came from.' },
];

export default function LoginPage() {
  // Read on the server so the copy always matches the actual policy rather
  // than promising a restriction that is not enforced.
  const restriction = allowedDomain();

  return (
    <div className="relative flex min-h-screen flex-col bg-background">
      {/* Red glow, top-left — the same accent wash masaischool.com uses behind its hero */}
      <div
        aria-hidden
        className="pointer-events-none absolute -left-40 -top-40 h-[32rem] w-[32rem] rounded-full bg-primary/20 blur-[120px]"
      />

      <header className="relative z-10 flex items-center justify-between px-6 py-5 sm:px-10">
        <div className="font-heading text-2xl font-bold leading-none tracking-tight text-foreground">
          masai<span className="text-primary">.</span>
        </div>
        <div className="eyebrow">Internal · MailFlow</div>
      </header>

      <main className="relative z-10 flex flex-1 items-center px-6 py-10 sm:px-10">
        <div className="mx-auto grid w-full max-w-6xl items-center gap-12 lg:grid-cols-[1.2fr_1fr]">
          <section className="rise-in">
            <div className="eyebrow mb-5">Email communication &amp; CRM</div>
            <h1 className="font-heading text-4xl font-bold leading-[1.05] tracking-tight text-foreground sm:text-5xl lg:text-6xl">
              Every email to every batch,
              <br />
              <span className="accent">sent from your Gmail.</span>
            </h1>
            <p className="mt-6 max-w-xl text-base text-muted-foreground sm:text-lg">
              Campaigns, automations and conversations for the Masai team — on top of your own data,
              with nothing going out until you have reviewed it.
            </p>

            <ul className="mt-10 grid gap-6 sm:grid-cols-3">
              {PILLARS.map((p) => (
                <li key={p.title} className="border-l-2 border-primary pl-4">
                  <div className="font-heading text-sm font-semibold text-foreground">{p.title}</div>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{p.body}</p>
                </li>
              ))}
            </ul>
          </section>

          <section className="rise-in panel p-8 [animation-delay:120ms]">
            <div className="eyebrow mb-2">Sign in</div>
            <h2 className="font-heading text-2xl font-bold tracking-tight text-foreground">Continue to MailFlow</h2>
            <p className="mb-8 mt-2 text-sm text-muted-foreground">
              Use the Google account you send from. You will connect Gmail separately after signing in.
            </p>
            <LoginButton />
            <p className="mt-5 text-xs text-faint">
              {restriction ? `Only @${restriction} accounts can sign in.` : 'Any Google account can sign in.'}
            </p>
          </section>
        </div>
      </main>

      <footer className="relative z-10 px-6 py-5 text-xs text-faint sm:px-10">
        © {new Date().getFullYear()} Masai School · Internal tool
      </footer>
    </div>
  );
}
