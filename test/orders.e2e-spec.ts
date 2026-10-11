import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../src/generated/prisma/client.js';

// Runs against the test database (DATABASE_URL is pointed at payments_test by vitest.config.e2e.ts).
describe('orders, payments and refunds tables (e2e)', () => {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  // Unique per run, so leftovers from an interrupted run cannot collide with this one.
  const run = Date.now();
  const paymentIntentId = `pi_test_${run}`;
  const orderIds: string[] = [];

  /** Creates an order with one succeeded payment and returns both. */
  async function createPaidOrder() {
    const order = await prisma.order.create({
      data: {
        status: 'PAID',
        amount: 4999,
        currency: 'usd',
        customerEmail: 'buyer@example.com',
        stripeCheckoutSessionId: `cs_test_${run}_${orderIds.length}`,
        payments: {
          create: {
            stripePaymentIntentId: `${paymentIntentId}_${orderIds.length}`,
            amount: 4999,
            currency: 'usd',
            status: 'SUCCEEDED',
          },
        },
      },
      include: { payments: true },
    });
    orderIds.push(order.id);
    return order;
  }

  afterAll(async () => {
    // Children first: the foreign keys use Restrict, so an order with payments cannot be deleted.
    const payments = { orderId: { in: orderIds } };
    await prisma.refund.deleteMany({ where: { payment: payments } });
    await prisma.payment.deleteMany({ where: payments });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.$disconnect();
  });

  it('stores an order → payment → refund chain and reads it back with relations', async () => {
    const order = await createPaidOrder();
    await prisma.refund.create({
      data: {
        paymentId: order.payments[0].id,
        stripeRefundId: `re_test_${run}`,
        amount: 1000,
        currency: 'usd',
        status: 'SUCCEEDED',
      },
    });

    const saved = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { payments: { include: { refunds: true } } },
    });

    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(saved.amount).toBe(4999);
    expect(saved.payments).toHaveLength(1);
    expect(saved.payments[0].refunds).toMatchObject([{ amount: 1000, status: 'SUCCEEDED' }]);
  });

  it('defaults a new order to PENDING', async () => {
    const order = await prisma.order.create({ data: { amount: 2500, currency: 'usd' } });
    orderIds.push(order.id);

    expect(order.status).toBe('PENDING');
  });

  it('rejects a second payment with the same Stripe payment intent ID (P2002)', async () => {
    const order = await createPaidOrder();

    const error = await prisma.payment
      .create({
        data: {
          orderId: order.id,
          stripePaymentIntentId: order.payments[0].stripePaymentIntentId,
          amount: 4999,
          currency: 'usd',
          status: 'SUCCEEDED',
        },
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((error as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
  });

  it('refuses to delete an order that has payments, and keeps the order', async () => {
    const order = await createPaidOrder();

    const error = await prisma.order.delete({ where: { id: order.id } }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    // P2003: foreign key constraint violated, raised by PostgreSQL's ON DELETE RESTRICT.
    expect((error as Prisma.PrismaClientKnownRequestError).code).toBe('P2003');
    expect(await prisma.order.count({ where: { id: order.id } })).toBe(1);
  });
});
