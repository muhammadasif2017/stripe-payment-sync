import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../src/generated/prisma/client.js';

// Runs against the test database (DATABASE_URL is pointed at payments_test by vitest.config.e2e.ts).
describe('stripe_events table (e2e)', () => {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  // A fresh ID per run, so leftover rows from an interrupted run cannot affect the result.
  const eventId = `evt_test_${Date.now()}`;

  const event = {
    id: eventId,
    type: 'checkout.session.completed',
    payload: { id: eventId, object: 'event', data: { object: { id: 'cs_test_123' } } },
    stripeCreatedAt: new Date('2026-10-11T12:00:00Z'),
  };

  afterAll(async () => {
    await prisma.stripeEvent.deleteMany({ where: { id: eventId } });
    await prisma.$disconnect();
  });

  it('stores an event with defaults for status and attempts', async () => {
    const saved = await prisma.stripeEvent.create({ data: event });

    expect(saved).toMatchObject({ id: eventId, status: 'PENDING', attempts: 0, lastError: null });
    expect(saved.receivedAt).toBeInstanceOf(Date);
  });

  it('rejects a second event with the same Stripe event ID (P2002) and keeps one row', async () => {
    const error = await prisma.stripeEvent.create({ data: event }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((error as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
    expect(await prisma.stripeEvent.count({ where: { id: eventId } })).toBe(1);
  });
});
