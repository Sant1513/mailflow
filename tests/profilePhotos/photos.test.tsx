import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * Profile photos from each mailbox's Google "Other contacts": real photos are kept (sized),
 * Google's generated letter avatars are skipped, and failures say what to do in plain words.
 */
const list = vi.fn();
vi.mock('googleapis', () => ({ google: { people: () => ({ otherContacts: { list } }) } }));
vi.mock('@/lib/gmail/oauth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/gmail/oauth')>('@/lib/gmail/oauth');
  return { ...actual, authorizedClientFor: vi.fn(async () => ({})) };
});
const executeRaw = vi.fn(async () => 1);
const update = vi.fn(async () => ({}));
vi.mock('@/lib/db/client', () => ({ prisma: { $executeRaw: executeRaw, emailProviderAccount: { update, findMany: vi.fn(async () => []) } } }));

const { syncProfilePhotos, sizedPhoto } = await import('@/lib/profilePhotos/sync');
const { hasScope, PHOTOS_OAUTH_SCOPE } = await import('@/lib/gmail/oauth');
const { Avatar, initialsOf } = await import('@/components/ui/Avatar');

const account = (scope: string) => ({ id: 'a1', organizationId: 'org1', emailAddress: 'me@masaischool.com', scope } as any);

beforeEach(() => vi.clearAllMocks());

describe('profile photos', () => {
  it('only runs for mailboxes that allowed it', async () => {
    const r = await syncProfilePhotos(account('https://www.googleapis.com/auth/gmail.send'));
    expect(r.error).toMatch(/not allowed/);
    expect(list).not.toHaveBeenCalled();
    expect(hasScope({ scope: `x ${PHOTOS_OAUTH_SCOPE}` }, PHOTOS_OAUTH_SCOPE)).toBe(true);
  });

  it('keeps real photos, skips Google letter avatars, pages through, and saves for the organization', async () => {
    list
      .mockResolvedValueOnce({ data: {
        otherContacts: [
          { emailAddresses: [{ value: 'Priya@Gmail.com' }], photos: [{ url: 'https://lh3.googleusercontent.com/a/abc=s100', default: false }] },
          { emailAddresses: [{ value: 'nophoto@gmail.com' }], photos: [{ url: 'https://lh3.googleusercontent.com/a/letter=s100', default: true }] },
        ],
        nextPageToken: 'p2',
      } })
      .mockResolvedValueOnce({ data: { otherContacts: [{ emailAddresses: [{ value: 'rahul@corp.in' }], photos: [{ url: 'https://lh3.googleusercontent.com/a/xyz=s100' }] }] } });
    const r = await syncProfilePhotos(account(PHOTOS_OAUTH_SCOPE));
    expect(r).toMatchObject({ contacts: 3, photos: 2 });
    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[1]?.[0]).toMatchObject({ pageToken: 'p2', readMask: 'emailAddresses,photos' });
    // The upsert gets the lower-cased addresses and the sized URLs, scoped to the organization.
    const sqlValues = (executeRaw.mock.calls[0] as unknown[]).slice(1);
    expect(sqlValues).toContain('org1');
    expect(sqlValues.flat()).toEqual(expect.arrayContaining(['priya@gmail.com', 'rahul@corp.in', 'https://lh3.googleusercontent.com/a/abc=s96-c']));
    expect(sqlValues.flat()).not.toContain('nophoto@gmail.com');
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { photosSyncedAt: expect.any(Date) } }));
  });

  it('explains a People API that is not switched on yet', async () => {
    list.mockRejectedValueOnce(Object.assign(new Error('People API has not been used in project 123 before or it is disabled.'), { code: 403 }));
    const r = await syncProfilePhotos(account(PHOTOS_OAUTH_SCOPE));
    expect(r.error).toMatch(/People API is not enabled/);
  });

  it('asks Google for a small, square photo', () => {
    expect(sizedPhoto('https://lh3.googleusercontent.com/a/abc=s100')).toBe('https://lh3.googleusercontent.com/a/abc=s96-c');
    expect(sizedPhoto('https://lh3.googleusercontent.com/a/abc=s100-c', 48)).toBe('https://lh3.googleusercontent.com/a/abc=s48-c');
  });

  it('shows initials until a photo is found', () => {
    expect(initialsOf('Priya Sharma', 'p@x.com')).toBe('PS');
    expect(initialsOf(null, 'rahul.mehta@corp.in')).toBe('RM');
    const html = renderToStaticMarkup(<Avatar email="priya@gmail.com" name="Priya Sharma" size={32} />);
    expect(html).toContain('PS');
    expect(html).not.toContain('<img');
  });
});
