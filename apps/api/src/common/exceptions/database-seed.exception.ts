import { InternalServerErrorException } from '@nestjs/common';

/**
 * Exception thrown when required database seed data is missing
 * This indicates the database migrations have been run but seeds have not
 */
export class DatabaseSeedException extends InternalServerErrorException {
  constructor(missingData: string, seedCommand = 'npm run prisma:seed') {
    const message = `Database seed data missing: ${missingData}. Please run: ${seedCommand}`;
    super({
      code: 'DATABASE_SEED_REQUIRED',
      message,
      details: {
        missingData,
        seedCommand,
        instructions: [
          'Database migrations have been run but seed data is missing',
          `Run the following command: ${seedCommand}`,
          'This will populate required data like roles and permissions',
        ],
      },
    });
  }
}
