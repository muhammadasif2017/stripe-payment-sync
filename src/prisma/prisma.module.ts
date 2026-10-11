import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';

/** Provides PrismaService to every module, so feature modules can inject it without importing this one. */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
