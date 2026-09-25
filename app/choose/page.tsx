import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { getOptionalSession } from '@/lib/auth/session';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { DEFAULT_PRODUCT_COOKIE, isProduct } from '@/lib/products';
import { ProductChooser } from './ProductChooser';

export const metadata = { title: 'Choose a product — MailFlow' };

export default async function ChooseProductPage() {
  const session = await getOptionalSession();
  if (!session) redirect('/login');
  if (session.status === 'PENDING') redirect('/pending');

  const saved = cookies().get(DEFAULT_PRODUCT_COOKIE)?.value;
  const firstName = (session.name ?? session.email).split(/[\s@]/)[0];

  return (
    <div className="relative flex min-h-screen flex-col bg-background">
      <div aria-hidden className="pointer-events-none absolute -left-40 -top-40 h-[32rem] w-[32rem] rounded-full bg-primary/20 blur-[120px]" />

      <header className="relative z-10 flex items-center justify-between px-6 py-5 sm:px-10">
        <div className="font-heading text-2xl font-bold leading-none tracking-tight text-foreground">
          masai<span className="text-primary">.</span>
        </div>
        <ThemeToggle compact />
      </header>

      <main className="relative z-10 flex flex-1 items-center px-6 py-10 sm:px-10">
        <div className="mx-auto w-full max-w-4xl">
          <div className="eyebrow mb-3">MailFlow</div>
          <h1 className="font-heading text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
            Hi {firstName}, where do you want to go?
          </h1>
          <p className="mt-3 text-sm text-muted-foreground sm:text-base">
            Pick a product. You can switch between them any time from the top of the sidebar.
          </p>
          <ProductChooser savedDefault={isProduct(saved) ? saved : null} />
        </div>
      </main>
    </div>
  );
}
