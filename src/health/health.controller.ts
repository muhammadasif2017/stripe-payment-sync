import { Controller, Get, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/** Liveness check for Docker, uptime monitors and the README's "is it running?" step. */
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
      // Prisma's message is often empty here; its error code (e.g. P1001 = can't reach server) names the cause.
      const { name, code } = error as { name?: string; code?: string };
      this.logger.error(`Database health check failed: ${name ?? 'Error'} ${code ?? ''}`.trim());
      throw new ServiceUnavailableException({ status: 'error' });
    }
  }
}
