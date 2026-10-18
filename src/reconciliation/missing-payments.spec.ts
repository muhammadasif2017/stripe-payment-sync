import { type ListedSession, selectMissing, windowStart } from './missing-payments.js';

const ORDER = '0b7c6b1e-4a5f-4c8e-9a51-3f2d8e1c7a90';
const OTHER_ORDER = '9b9d90ea-c217-41cb-ad99-f6165a0b9980';

function session(fields: Partial<ListedSession> = {}): ListedSession {
  return {
    id: 'cs_test_1',
    payment_status: 'paid',
    payment_intent: 'pi_1',
    metadata: { order_id: ORDER },
    client_reference_id: ORDER,
    ...fields,
  };
}

describe('windowStart', () => {
  it('is 2 days before the run, in Unix seconds', () => {
    const now = new Date('2026-10-16T03:00:00.900Z');

    // 1_792_119_600 is 2026-10-16T03:00:00Z in seconds; Stripe's `created` filter is in seconds.
    expect(windowStart(now)).toBe(Math.floor(now.getTime() / 1000) - 172_800);
    expect(windowStart(now)).toBe(1_791_946_800);
  });
});

describe('selectMissing', () => {
  const known = new Set([ORDER, OTHER_ORDER]);

  it('picks a paid session of a known order with no SUCCEEDED payment', () => {
    const s = session();

    const { missing, summary } = selectMissing([s], known, new Set());

    expect(missing).toEqual([s]);
    expect(summary).toMatchObject({ checked: 1, missing: 1 });
  });

  it('skips a session whose payment is already recorded', () => {
    const { missing, summary } = selectMissing([session()], known, new Set(['pi_1']));

    expect(missing).toEqual([]);
    expect(summary).toMatchObject({ alreadyRecorded: 1, missing: 0 });
  });

  it('reads an expanded payment intent object too', () => {
    const s = session({ payment_intent: { id: 'pi_1' } as ListedSession['payment_intent'] });

    expect(selectMissing([s], known, new Set(['pi_1'])).summary.alreadyRecorded).toBe(1);
  });

  it.each([
    ['unpaid', session({ payment_status: 'unpaid' }), 'notPaid'],
    ['without a payment intent', session({ payment_intent: null }), 'notPaid'],
    [
      'without an order ID (stripe trigger)',
      session({ metadata: {}, client_reference_id: null }),
      'noOrderId',
    ],
    [
      'with an order ID that is not a UUID',
      session({ metadata: { order_id: 'abc' }, client_reference_id: null }),
      'noOrderId',
    ],
    [
      'of an order not in the database',
      session({
        metadata: { order_id: '00000000-0000-4000-8000-000000000000' },
        client_reference_id: null,
      }),
      'unknownOrder',
    ],
  ])('skips a session %s and counts why', (_case, s, reason) => {
    const { missing, summary } = selectMissing([s], known, new Set());

    expect(missing).toEqual([]);
    expect(summary).toMatchObject({ checked: 1, missing: 0, [reason]: 1 });
  });

  it('counts a mixed run', () => {
    const sessions = [
      session({ id: 'cs_a', payment_intent: 'pi_a' }),
      session({ id: 'cs_b', payment_intent: 'pi_b' }),
      session({ id: 'cs_c', metadata: {}, client_reference_id: null }),
      session({ id: 'cs_d', payment_status: 'unpaid' }),
    ];

    const { missing, summary } = selectMissing(sessions, known, new Set(['pi_a']));

    expect(missing.map((s) => s.id)).toEqual(['cs_b']);
    expect(summary).toEqual({
      checked: 4,
      notPaid: 1,
      noOrderId: 1,
      unknownOrder: 0,
      alreadyRecorded: 1,
      openIssues: 0,
      missing: 1,
    });
  });

  it('skips a missing session with an open issue and counts it', () => {
    const { missing, summary } = selectMissing(
      [session()],
      known,
      new Set(),
      new Set(['cs_test_1']),
    );

    expect(missing).toEqual([]);
    expect(summary).toMatchObject({ openIssues: 1, missing: 0 });
  });

  it('counts a recorded payment as recorded even if an old issue is still open', () => {
    const { summary } = selectMissing(
      [session()],
      known,
      new Set(['pi_1']),
      new Set(['cs_test_1']),
    );

    expect(summary).toMatchObject({ alreadyRecorded: 1, openIssues: 0 });
  });
});
