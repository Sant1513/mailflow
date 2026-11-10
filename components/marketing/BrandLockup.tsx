/**
 * "MailFlow by Masai" lockup in the Leap style: the product name as the wordmark (with the red
 * Masai full stop) and "BY MASAI" in small spaced mono underneath, like Leap's "LEAP. / BY MASAI".
 */
export function BrandLockup({ size = 'nav' }: { size?: 'nav' | 'footer' }) {
  return (
    <span className={`lockup lockup--${size}`}>
      <span className="lockup-name">
        MailFlow<span className="lockup-dot">.</span>
      </span>
      <span className="lockup-by mono">by Masai</span>
    </span>
  );
}
