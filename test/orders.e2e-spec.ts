import { Prisma } from '../src/generated/prisma/client.js';
import { createTestPrisma } from './test-prisma.js';

describe('orders, payments and refunds tables (e2e)', () => {
  const prisma = createTestPrisma();
  // Unique per run, so leftovers from an interrupted run cannot collide with this one.
  const run = Date.now();
  const paymentIntentId = `pi_test_${run}`;
  const orderIds: string[] = [];

  /** Creates an order with one succeeded payment and returns both. */
  async function createPaidOrder() {
    const order = await prisma.order.create({
      data: {
        status: 'PAID',
        courseId: 'nestjs-fundamentals',
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
    const order = await prisma.order.create({
      data: { courseId: 'nestjs-fundamentals', amount: 2500, currency: 'usd' },
    });
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

  it('stores an expired order and a canceled payment', async () => {
    const order = await createPaidOrder();

    await prisma.order.update({ where: { id: order.id }, data: { status: 'EXPIRED' } });
    await prisma.payment.update({
      where: { id: order.payments[0].id },
      data: { status: 'CANCELED' },
    });

    const saved = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { payments: true },
    });
    expect(saved.status).toBe('EXPIRED');
    expect(saved.payments[0].status).toBe('CANCELED');
  });

  it.each([0, -100])('rejects an amount of %i on orders, payments and refunds', async (amount) => {
    const order = await createPaidOrder();
    const paymentId = order.payments[0].id;

    const orderAttempt = await prisma.order
      .create({ data: { courseId: 'nestjs-fundamentals', amount, currency: 'usd' } })
      .catch((e: unknown) => e);
    // If the row slipped through, record it for cleanup before the assertion fails the test.
    // (Payments and refunds below belong to `order`, which is already cleaned up.)
    if (!(orderAttempt instanceof Error)) orderIds.push((orderAttempt as { id: string }).id);
    expect(orderAttempt).toBeInstanceOf(Error);
    expect((orderAttempt as Error).message).toMatch(/orders_amount_positive/);

    const childAttempts = [
      prisma.payment.create({
        data: {
          orderId: order.id,
          stripePaymentIntentId: `pi_test_${run}_amount_${amount}`,
          amount,
          currency: 'usd',
          status: 'SUCCEEDED',
        },
      }),
      prisma.refund.create({
        data: {
          paymentId,
          stripeRefundId: `re_test_${run}_amount_${amount}`,
          amount,
          currency: 'usd',
          status: 'SUCCEEDED',
        },
      }),
    ];

    const [paymentResult, refundResult] = await Promise.all(
      childAttempts.map((attempt) => attempt.catch((e: unknown) => e)),
    );
    expect((paymentResult as Error).message).toMatch(/payments_amount_positive/);
    expect((refundResult as Error).message).toMatch(/refunds_amount_positive/);
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
