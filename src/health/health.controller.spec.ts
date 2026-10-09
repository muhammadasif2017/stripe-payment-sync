import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import type { PrismaService } from '../prisma/prisma.service.js';

function controllerWith(queryRaw: () => Promise<unknown>): HealthController {
  return new HealthController({ $queryRaw: queryRaw } as unknown as PrismaService);
}

describe('HealthController', () => {
  it('returns ok when the database answers', async () => {
    const controller = controllerWith(() => Promise.resolve([{ '?column?': 1 }]));

    await expect(controller.check()).resolves.toEqual({ status: 'ok' });
  });

  it('throws 503 when the database query fails', async () => {
    const controller = controllerWith(() =>
      Promise.reject(new Error('connect ECONNREFUSED postgresql://payments:secret@localhost:5435')),
    );

    await expect(controller.check()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('does not leak the database error in the 503 response', async () => {
    const controller = controllerWith(() =>
      Promise.reject(new Error('connect ECONNREFUSED postgresql://payments:secret@localhost:5435')),
    );

    const error = await controller.check().catch((e: ServiceUnavailableException) => e);

    expect(JSON.stringify((error as ServiceUnavailableException).getResponse())).not.toContain(
      'secret',
    );
  });
});
