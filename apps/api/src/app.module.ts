import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ZodValidationPipe } from 'nestjs-zod';

import { PrismaModule } from './prisma/prisma.module';
import { CommonModule } from './common/common.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { SettingsModule } from './settings/settings.module';
import { HealthModule } from './health/health.module';
import { AllowlistModule } from './allowlist/allowlist.module';
import { DeviceAuthModule } from './device-auth/device-auth.module';
import { StorageModule } from './storage/storage.module';
import { PatModule } from './pat/pat.module';
import { GitHubModule } from './github/github.module';
import { RepositoriesModule } from './repositories/repositories.module';
import { ReconcilerModule } from './reconciler/reconciler.module';
import { RunEventsModule } from './run-events/run-events.module';
import { EscalationsModule } from './escalations/escalations.module';
import { NotificationsModule } from './notifications/notifications.module';
import { CockpitModule } from './cockpit/cockpit.module';
import { DispatchModule } from './dispatch/dispatch.module';
import { RunnersModule } from './runners/runners.module';
import { WorkOrdersModule } from './work-orders/work-orders.module';
import { TelemetryModule } from './telemetry/telemetry.module';
import { LoggerModule } from './common/logger/logger.module';
import { TestAuthModule } from './test-auth/test-auth.module';

import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';

import configuration from './config/configuration';

@Module({
  imports: [
    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),

    // Scheduling (must be at root level for NestJS 11)
    ScheduleModule.forRoot(),

    // Event emitter for async events
    EventEmitterModule.forRoot(),

    // Database
    PrismaModule,

    // Logger
    LoggerModule,

    // Feature modules
    CommonModule,
    AuthModule,
    UsersModule,
    SettingsModule,
    HealthModule,
    AllowlistModule,
    DeviceAuthModule,
    StorageModule,
    PatModule,

    // GitHub edge (epic #15)
    GitHubModule,
    RepositoriesModule,
    ReconcilerModule,
    // Global, and first among the factory modules: everything that measures
    // success metric 1 injects FactoryMetrics, and a module that cannot reach
    // it silently stops being instrumented.
    TelemetryModule,
    RunEventsModule,
    EscalationsModule,
    NotificationsModule,
    // Nothing dispatches yet (#64). Registered so the records service is
    // wired and bootable, and so the one module that can create branches is
    // visible in the application's import list rather than only in a test.
    WorkOrdersModule,
    // Decides WHICH runner, and hands over to nobody — there is no executor
    // until #61. Registered so the decision path is bootable and exercised.
    DispatchModule,
    // The cockpit read models (#80) — read-only, one family per module.
    CockpitModule,
    RunnersModule,

    // Test modules (non-production only)
    // TestAuthModule bypasses both OAuth and the email allowlist, so NODE_ENV
    // alone is not a sufficient gate: a non-production deployment can still be
    // reachable from the internet (e.g. a dev host serving the Vite dev server,
    // which requires NODE_ENV=development). TEST_AUTH_ENABLED=false lets such a
    // deployment turn the bypass off, as .env.example has always documented.
    ...(process.env.NODE_ENV !== 'production' &&
    process.env.TEST_AUTH_ENABLED !== 'false'
      ? [TestAuthModule]
      : []),
  ],
  providers: [
    // Global validation pipe (Zod)
    {
      provide: APP_PIPE,
      useClass: ZodValidationPipe,
    },
    // Global exception filter
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter,
    },
    // Global logging interceptor
    {
      provide: APP_INTERCEPTOR,
      useClass: LoggingInterceptor,
    },
    // Global response transform interceptor
    {
      provide: APP_INTERCEPTOR,
      useClass: TransformInterceptor,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
