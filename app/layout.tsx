import type { Metadata } from 'next';
import { Outfit, Poppins } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';
import { THEME_INIT_SCRIPT } from '@/components/theme/ThemeToggle';
import { SwRegistration } from '@/components/pwa/SwRegistration';
import { InstallPrompt } from '@/components/pwa/InstallPrompt';

const outfit = Outfit({ subsets: ['latin'], weight: ['300', '400', '500', '600', '700', '800'], variable: '--font-outfit', display: 'swap' });
const poppins = Poppins({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-poppins', display: 'swap' });

export const metadata: Metadata = {
  title: 'MailFlow — Masai School',
  description: 'Internal email communication, automation and CRM platform for Masai School.',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    title: 'MailFlow',
    statusBarStyle: 'black-translucent',
  },
  icons: {
    icon: '/icons/icon.svg',
    apple: '/icons/icon.svg',
  },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fafafa' },
    { media: '(prefers-color-scheme: dark)', color: '#09090b' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: the theme script adds the `dark` class before
    // React hydrates, which is intentional and must not be "fixed" by React.
    <html lang="en" className={`${outfit.variable} ${poppins.variable}`} suppressHydrationWarning>
      <body className="min-h-screen font-sans antialiased">
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <Providers>{children}</Providers>
        <SwRegistration />
        <InstallPrompt />
      </body>
    </html>
  );
}
