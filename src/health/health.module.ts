import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';

/** Exposes GET /health. PrismaService comes from the global PrismaModule. */
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
