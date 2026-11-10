import { ImageResponse } from 'next/og';

// Edge: @vercel/og's Node build can't find its bundled font on Windows (Next 14), edge can.
export const runtime = 'edge';
export const alt = 'MailFlow: every email to every batch, sent from your Gmail.';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

/** Social preview card in the Masai colours: ink background, red glow, the hero headline. */
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '72px 80px',
          background: '#101014',
          position: 'relative',
          fontFamily: 'sans-serif',
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: -220,
            right: -160,
            width: 640,
            height: 640,
            borderRadius: 9999,
            background: 'radial-gradient(circle, rgba(237,3,49,0.55) 0%, rgba(237,3,49,0) 70%)',
          }}
        />
        <div
          style={{
            position: 'absolute',
            bottom: -260,
            left: -120,
            width: 560,
            height: 560,
            borderRadius: 9999,
            background: 'radial-gradient(circle, rgba(247,112,52,0.28) 0%, rgba(247,112,52,0) 70%)',
          }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: 9999,
              background: 'linear-gradient(135deg, #ED0331, #F77034)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'white',
              fontSize: 30,
              fontWeight: 700,
            }}
          >
            m
          </div>
          <div style={{ color: 'white', fontSize: 34, fontWeight: 700, letterSpacing: -0.5 }}>MailFlow</div>
          <div style={{ color: 'rgba(255,255,255,0.55)', fontSize: 22, marginLeft: 8 }}>by Masai</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ color: 'white', fontSize: 72, fontWeight: 800, lineHeight: 1.05, letterSpacing: -2 }}>Every email to every batch,</div>
          <div style={{ color: '#FF2E58', fontSize: 72, fontWeight: 800, lineHeight: 1.05, letterSpacing: -2 }}>sent from your Gmail.</div>
          <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 28, marginTop: 28 }}>
            Campaigns · Shared inbox · E-signatures, with dry runs and approvals.
          </div>
        </div>
      </div>
    ),
    size,
  );
}
