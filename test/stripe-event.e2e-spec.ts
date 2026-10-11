import { Prisma } from '../src/generated/prisma/client.js';
import { createTestPrisma } from './test-prisma.js';

describe('stripe_events table (e2e)', () => {
  const prisma = createTestPrisma();
  // Unique per run, so leftover rows from an interrupted run cannot affect the result.
  const run = Date.now();
  const eventIds: string[] = [];

  /** Builds a Stripe-like event with its own ID, and remembers the ID for cleanup. */
  function makeEvent(name: string) {
    const id = `evt_test_${run}_${name}`;
    eventIds.push(id);
    return {
      id,
      type: 'checkout.session.completed',
      payload: { id, object: 'event', data: { object: { id: 'cs_test_123' } } },
      stripeCreatedAt: new Date('2026-10-11T12:00:00Z'),
    };
  }

  afterAll(async () => {
    await prisma.stripeEvent.deleteMany({ where: { id: { in: eventIds } } });
    await prisma.$disconnect();
  });

  it('stores an event with defaults for status and attempts', async () => {
    const event = makeEvent('defaults');

    const saved = await prisma.stripeEvent.create({ data: event });

    expect(saved).toMatchObject({ id: event.id, status: 'PENDING', attempts: 0, lastError: null });
    expect(saved.receivedAt).toBeInstanceOf(Date);
  });

  it('rejects a second event with the same Stripe event ID (P2002) and keeps one row', async () => {
    // Inserts its own first copy, so this test doesn't depend on the one above.
    const event = makeEvent('duplicate');
    await prisma.stripeEvent.create({ data: event });

    const error = await prisma.stripeEvent.create({ data: event }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((error as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
    expect(await prisma.stripeEvent.count({ where: { id: event.id } })).toBe(1);
  });
});
