import { describe, expect, it, vi, beforeEach } from 'vitest';

const db = {
  rsvpResponse: { count: vi.fn(), upsert: vi.fn(), findUnique: vi.fn() },
  emailJob: { findUnique: vi.fn() },
  campaign: { findUnique: vi.fn() },
  notification: { create: vi.fn() },
};
vi.mock('@/lib/db/client', () => ({ prisma: db }));
vi.mock('@/lib/records/systemUpdate', () => ({ ensureColumns: vi.fn(), updateRecordFields: vi.fn(async () => ({ changed: [] })) }));

const { defaultRsvpConfig, renderRsvpBlock, placeRsvpBlock, stripRsvpPlaceholder, readRsvpConfig, renderRsvpText } = await import('@/lib/rsvp/config');
const { recordRsvp, columnKeyFor } = await import('@/lib/rsvp/respond');
const systemUpdate = await import('@/lib/records/systemUpdate');

const payload = { campaignId: 'c1', emailJobId: 'j1', email: 'Rahul@Example.com' };
const campaign = { id: 'c1', name: 'Placement drive', workspaceId: 'w1', createdById: 'u1', datasetId: 'd1' };

beforeEach(() => {
  vi.clearAllMocks();
  db.emailJob.findUnique.mockResolvedValue({ recordId: 'r1' });
  db.rsvpResponse.count.mockResolvedValue(0);
});

describe('RSVP buttons in the email', () => {
  const config = defaultRsvpConfig();

  it('renders one email-safe button per answer with its own link, escaping text', () => {
    const html = renderRsvpBlock({ ...config, question: 'Will you <come>?' }, (k) => `https://x/rsvp/T?a=${k}`);
    expect(html).toContain('https://x/rsvp/T?a=yes');
    expect(html).toContain('https://x/rsvp/T?a=no');
    expect(html).toContain('Will you &lt;come&gt;?');
    expect(html).toContain('bgcolor="#16a34a"');
    expect(html).not.toMatch(/<script/i);
  });

  it('goes where [[rsvp]] is, otherwise before </body>', () => {
    expect(placeRsvpBlock('<p>Hi</p>[[rsvp]]<p>Bye</p>', 'BTN')).toBe('<p>Hi</p>BTN<p>Bye</p>');
    expect(placeRsvpBlock('<p>Hi</p><div data-mailflow-rsvp></div>', 'BTN')).toBe('<p>Hi</p>BTN');
    expect(placeRsvpBlock('<html><body><p>Hi</p></body></html>', 'BTN')).toBe('<html><body><p>Hi</p>BTN</body></html>');
    expect(stripRsvpPlaceholder('<p>a</p>[[ rsvp ]]')).toBe('<p>a</p>');
  });

  it('has a plain-text version and validates stored settings', () => {
    expect(renderRsvpText(config, (k) => `L-${k}`)).toContain("Yes, I'll attend: L-yes");
    expect(readRsvpConfig({ ...config, enabled: false })).toBeNull();
    expect(readRsvpConfig({ ...config, options: [] })).toBeNull();
    expect(readRsvpConfig(config)?.options).toHaveLength(2);
  });
});

describe('recording an answer', () => {
  const ctx = (overrides: Partial<ReturnType<typeof defaultRsvpConfig>> = {}, current: { answer: string; note: string | null } | null = null) => ({
    config: { ...defaultRsvpConfig(), ...overrides },
    campaign,
    current,
  });
  const input = { answer: 'yes', ip: null, userAgent: 'Mozilla/5.0' };

  it('records a first answer, lower-casing the address', async () => {
    const out = await recordRsvp(ctx(), payload, input);
    expect(out.status).toBe('recorded');
    expect(db.rsvpResponse.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ email: 'rahul@example.com', answer: 'yes', recordId: 'r1' }) }));
  });

  it('rejects unknown answers and answers after the deadline', async () => {
    expect((await recordRsvp(ctx(), payload, { ...input, answer: 'nope' })).status).toBe('invalid');
    expect((await recordRsvp(ctx({ deadline: '2020-01-01T00:00:00.000Z' }), payload, input)).status).toBe('closed');
    expect(db.rsvpResponse.upsert).not.toHaveBeenCalled();
  });

  it('keeps the first answer when changes are not allowed', async () => {
    const out = await recordRsvp(ctx({ allowChange: false }, { answer: 'no', note: null }), payload, input);
    expect(out.status).toBe('locked');
    expect(db.rsvpResponse.upsert).not.toHaveBeenCalled();
  });

  it('stops at the seat limit, but people already holding a seat keep it', async () => {
    const full = { ...defaultRsvpConfig() };
    full.options = full.options.map((o) => (o.key === 'yes' ? { ...o, capacity: 2 } : o));
    db.rsvpResponse.count.mockResolvedValue(2);
    expect((await recordRsvp({ config: full, campaign, current: null }, payload, input)).status).toBe('full');
    // Same answer again (e.g. adding a note) is fine even when full.
    expect((await recordRsvp({ config: full, campaign, current: { answer: 'yes', note: null } }, payload, { ...input, note: 'Bringing my resume' })).status).toBe('recorded');
  });

  it('writes the answer onto the data row when a column is chosen', async () => {
    await recordRsvp(ctx({ saveToColumn: 'Drive RSVP' }), payload, { ...input, note: 'see you' });
    expect(systemUpdate.updateRecordFields).toHaveBeenCalledWith(
      expect.objectContaining({ recordId: 'r1', fields: { Drive_RSVP: "Yes, I'll attend", Drive_RSVP_note: 'see you' } }),
    );
    expect(columnKeyFor('2026 drive')).toBe('col_2026_drive');
  });

  it('does nothing when the same answer is clicked again', async () => {
    const out = await recordRsvp(ctx({}, { answer: 'yes', note: null }), payload, input);
    expect(out.status).toBe('unchanged');
    expect(db.rsvpResponse.upsert).not.toHaveBeenCalled();
  });
});
