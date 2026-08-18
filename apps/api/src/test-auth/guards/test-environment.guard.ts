import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Guard that only allows requests in non-production environments
 * Used to protect test/development endpoints from being accessed in production
 */
@Injectable()
export class TestEnvironmentGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const nodeEnv = this.configService.get<string>('nodeEnv');

    if (nodeEnv === 'production') {
      throw new ForbiddenException(
        'Test authentication endpoints are not available in production',
      );
    }

    return true;
  }
}
