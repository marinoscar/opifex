import { Module } from '@nestjs/common';

import { GitBranchModule } from '../github/git/git-branch.module';
import { GitHubReadModule } from '../github/read/github-read.module';
import { GitHubWriteModule } from '../github/write/github-write.module';
import { PrismaModule } from '../prisma/prisma.module';
import { WorkOrderProjectionService } from './work-order-projection.service';
import { WorkOrderRecordsService } from './work-order-records.service';

/**
 * Work orders, and the two records that prove one was authorized.
 *
 * Note the import list: this module can create branches, and that is visible
 * here rather than buried. Nothing else in the application imports
 * `GitBranchModule`, which is the greppable form of "only dispatch creates
 * branches" (ADR-0005).
 *
 * Generation itself (`work-order-generator.ts`, `work-order-identity.ts`,
 * `issue-projection.ts`) is pure and needs no provider — it is imported
 * directly by whatever computes a work order, which keeps the deterministic
 * half testable with nothing wired. `WorkOrderProjectionService` is the other
 * half: the one that writes, kept separate for the reason #46 separates
 * compute from apply — a projection that could write cannot be run during the
 * observation week to find out what it WOULD have produced.
 */
@Module({
  imports: [GitHubReadModule, GitHubWriteModule, GitBranchModule, PrismaModule],
  providers: [WorkOrderRecordsService, WorkOrderProjectionService],
  exports: [WorkOrderRecordsService, WorkOrderProjectionService],
})
export class WorkOrdersModule {}
