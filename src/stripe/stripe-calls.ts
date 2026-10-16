import { Injectable, Logger } from '@nestjs/common';

/**
 * What a Stripe call is for, shown in its log line: the Stripe event being processed, the order being
 * checked out (no event exists yet), or a named background job.
 */
export type StripeCallContext = { eventId: string } | { orderId: string } | { job: string };

/** The status and request ID Stripe attaches to every result (`lastResponse`) and to API errors. */
interface ResponseInfo {
  lastResponse?: { statusCode?: number; requestId?: string };
}

/** The fields of a Stripe error the log line uses; a non-Stripe error has none of them. */
interface StripeErrorInfo {
  type?: string;
  statusCode?: number;
  requestId?: string;
}

/**
 * Runs Stripe calls and logs one line per call: endpoint, event or order ID, status, Stripe request ID
 * and duration. Parameters and bodies are never logged (a Checkout Session carries the customer's email).
 */
@Injectable()
export class StripeCalls {
  private readonly logger = new Logger(StripeCalls.name);

  /**
   * Runs one Stripe call and logs its outcome.
   * @param endpoint Fixed name of the call, such as `'paymentIntents.retrieve'`.
   * @param context The event, order or job the call belongs to.
   * @param call The call itself.
   * @returns Whatever the call returns.
   * @throws The call's own error, unchanged, so callers can still classify it by its Stripe type.
   */
  async run<T>(endpoint: string, context: StripeCallContext, call: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    try {
      const result = await call();
      const response = (result as ResponseInfo | null)?.lastResponse;
      this.logger.log(
        formatLine(endpoint, context, {
          status: String(response?.statusCode ?? 'ok'),
          requestId: response?.requestId,
          startedAt,
        }),
      );
      return result;
    } catch (error) {
      const { type, statusCode, requestId } = (error ?? {}) as StripeErrorInfo;
      const kind = type ?? (error instanceof Error ? error.name : 'unknown error');
      // No status code means no response arrived: a connection error or a timeout.
      const status = statusCode === undefined ? 'no response' : String(statusCode);
      this.logger.warn(
        formatLine(endpoint, context, { status: `${status} (${kind})`, requestId, startedAt }),
      );
      throw error;
    }
  }
}

function formatLine(
  endpoint: string,
  context: StripeCallContext,
  outcome: { status: string; requestId?: string; startedAt: number },
): string {
  const owner =
    'eventId' in context
      ? `event=${context.eventId}`
      : 'orderId' in context
        ? `order=${context.orderId}`
        : `job=${context.job}`;
  const duration = Math.round(performance.now() - outcome.startedAt);
  const request = outcome.requestId ? ` request=${outcome.requestId}` : '';
  return `${endpoint} ${owner} status=${outcome.status} duration=${duration}ms${request}`;
}
