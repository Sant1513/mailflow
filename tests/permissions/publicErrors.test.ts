import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth/options', () => ({ authOptions: {} }));
vi.mock('@/lib/db/client', () => ({ prisma: {} }));
const { publicErrorMessage } = await import('@/lib/api/respond');

describe('500 messages shown to the browser', () => {
  it('keeps our own short messages', () => {
    expect(publicErrorMessage(new Error('Gmail needs reconnecting'))).toBe('Gmail needs reconnecting');
  });

  it('hides database and internal errors', () => {
    const prismaErr = Object.assign(new Error('Invalid `prisma.user.findMany()` invocation: column "x" does not exist'), { name: 'PrismaClientKnownRequestError' });
    expect(publicErrorMessage(prismaErr)).toMatch(/Something went wrong/);
    expect(publicErrorMessage(new Error('connect to postgresql://user:pw@db.example.com failed'))).toMatch(/Something went wrong/);
    expect(publicErrorMessage(new Error('line one\n    at stack frame'))).toMatch(/Something went wrong/);
    expect(publicErrorMessage('a string')).toMatch(/Something went wrong/);
  });
});
