import { IBM_Plex_Mono, Poppins } from 'next/font/google';

/** The landing page's type (Masai's Leap look): Poppins for everything, IBM Plex Mono for labels. */
export const leapSans = Poppins({ subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--font-leap', display: 'swap' });
export const leapMono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '600'], variable: '--font-leap-mono', display: 'swap' });
