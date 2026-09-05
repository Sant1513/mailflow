import type { Metadata } from 'next';
import { Outfit, Poppins } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';

// The reference site sets Outfit on headings and body copy and Poppins on
// controls. next/font self-hosts both, so there is no render-blocking
// request to Google Fonts and no layout shift while they load.
const outfit = Outfit({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700', '800'],
  variable: '--font-outfit',
  display: 'swap',
});

const poppins = Poppins({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-poppins',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'MailFlow — Masai School',
  description: 'Internal communication, automation and CRM platform',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // `dark` matches tailwind's darkMode:'class'; the palette itself is dark
    // by design (globals.css), so this is for any dark: variants we add later.
    <html lang="en" className={`dark ${outfit.variable} ${poppins.variable}`}>
      <body className="min-h-screen font-sans antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
