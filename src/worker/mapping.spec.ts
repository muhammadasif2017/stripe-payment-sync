import {
  deriveOrderStatus,
  PermanentProcessingError,
  toPaymentStatus,
  toRefundStatus,
  type OrderFacts,
} from './mapping.js';

const declined = { code: 'card_declined' } as never;

describe('toPaymentStatus', () => {
  it.each([
    ['succeeded', null, 'SUCCEEDED'],
    ['canceled', null, 'CANCELED'],
    ['requires_payment_method', declined, 'FAILED'],
    ['requires_payment_method', null, null],
    ['processing', null, null],
    ['requires_action', null, null],
    ['requires_confirmation', null, null],
  ] as const)('maps %s (error: %o) to %s', (status, error, expected) => {
    expect(toPaymentStatus({ status, last_payment_error: error })).toBe(expected);
  });
});

describe('toRefundStatus', () => {
  it.each([
    ['succeeded', 'SUCCEEDED'],
    ['failed', 'FAILED'],
    ['canceled', 'CANCELED'],
    ['pending', 'PENDING'],
    ['requires_action', 'PENDING'],
    [null, 'PENDING'],
    ['some_future_status', 'PENDING'],
  ] as const)('maps %s to %s', (status, expected) => {
    expect(toRefundStatus(status)).toBe(expected);
  });
});

describe('deriveOrderStatus', () => {
  const facts = (overrides: Partial<OrderFacts>): OrderFacts => ({
    checkoutExpired: false,
    payments: [],
    refunds: [],
    ...overrides,
  });
  const paid = { status: 'SUCCEEDED', amount: 4900 } as const;

  it('is PENDING with no payments', () => {
    expect(deriveOrderStatus(facts({}))).toBe('PENDING');
  });

  it('is PAID after a succeeded payment', () => {
    expect(deriveOrderStatus(facts({ payments: [paid] }))).toBe('PAID');
  });

  it('is PAID when a declined card was followed by a successful one', () => {
    const payments = [{ status: 'FAILED', amount: 4900 } as const, paid];
    expect(deriveOrderStatus(facts({ payments }))).toBe('PAID');
  });

  it('is PARTIALLY_REFUNDED when part of the payment was refunded', () => {
    const refunds = [{ status: 'SUCCEEDED', amount: 1000 } as const];
    expect(deriveOrderStatus(facts({ payments: [paid], refunds }))).toBe('PARTIALLY_REFUNDED');
  });

  it('is REFUNDED when refunds add up to the payment', () => {
    const refunds = [
      { status: 'SUCCEEDED', amount: 1000 } as const,
      { status: 'SUCCEEDED', amount: 3900 } as const,
    ];
    expect(deriveOrderStatus(facts({ payments: [paid], refunds }))).toBe('REFUNDED');
  });

  it('ignores refunds that are pending, failed or canceled', () => {
    const refunds = [
      { status: 'PENDING', amount: 4900 } as const,
      { status: 'FAILED', amount: 4900 } as const,
      { status: 'CANCELED', amount: 4900 } as const,
    ];
    expect(deriveOrderStatus(facts({ payments: [paid], refunds }))).toBe('PAID');
  });

  it('is PAYMENT_FAILED after a declined card with nothing paid', () => {
    const payments = [{ status: 'FAILED', amount: 4900 } as const];
    expect(deriveOrderStatus(facts({ payments }))).toBe('PAYMENT_FAILED');
  });

  it('stays EXPIRED when the payment intent is canceled after the checkout expired', () => {
    const payments = [{ status: 'CANCELED', amount: 4900 } as const];
    expect(deriveOrderStatus(facts({ checkoutExpired: true, payments }))).toBe('EXPIRED');
  });

  it('is EXPIRED rather than PAYMENT_FAILED once the checkout expired', () => {
    const payments = [{ status: 'FAILED', amount: 4900 } as const];
    expect(deriveOrderStatus(facts({ checkoutExpired: true, payments }))).toBe('EXPIRED');
  });

  it('is PAID even if the checkout is marked expired, because money was paid', () => {
    expect(deriveOrderStatus(facts({ checkoutExpired: true, payments: [paid] }))).toBe('PAID');
  });

  it('refuses refunds larger than the amount paid', () => {
    const refunds = [{ status: 'SUCCEEDED', amount: 5000 } as const];
    expect(() => deriveOrderStatus(facts({ payments: [paid], refunds }))).toThrow(
      PermanentProcessingError,
    );
  });

  it('refuses a succeeded refund with no succeeded payment', () => {
    const refunds = [{ status: 'SUCCEEDED', amount: 100 } as const];
    expect(() => deriveOrderStatus(facts({ refunds }))).toThrow('exceed the amount paid');
  });
});
