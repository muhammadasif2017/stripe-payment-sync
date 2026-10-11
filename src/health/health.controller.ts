import { Controller, Get, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Readiness check: "can this instance serve requests right now?", including its database.
 * Use it for load balancers, uptime monitors and the README's "is it running?" step.
 * Do not use it as a container liveness probe: a short database outage would restart healthy containers.
 */
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Pings PostgreSQL with `SELECT 1`, so a 200 proves the app can reach its database,
   * not only that the HTTP server is up.
   * @returns `{ status: 'ok' }` when the database answers.
   * @throws ServiceUnavailableException (503) when it does not; the cause is logged, never returned.
   */
  @Get()
  async check(): Promise<{ status: 'ok' }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok' };
    } catch (error) {
      // Normalise first: a rejection is not guaranteed to be an Error (it could be undefined).
      const err = error instanceof Error ? error : new Error(String(error));
      // Prisma's message is often empty here; its code (e.g. ECONNREFUSED, P1001) names the cause.
      const code = (err as { code?: unknown }).code;
      this.logger.error(
        `Database health check failed: ${err.name}${typeof code === 'string' ? ` ${code}` : ''}`,
        err.stack,
      );
      throw new ServiceUnavailableException({ status: 'error' });
    }
  }
}
