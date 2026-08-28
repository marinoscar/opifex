import { Module } from '@nestjs/common';

import { GitHubModule } from '../github.module';
import { GitHubReadModule } from '../read/github-read.module';
import { LabelProvisioningService } from './label-provisioning.service';

/**
 * Label creation, separated from every other write (#415).
 *
 * A module of one service, which is the point — the same argument
 * `GitBranchModule` makes. Importing it is a visible, greppable statement that
 * a component can create labels on a repository, and revoking the capability
 * later means deleting a module rather than untangling a widened guard.
 *
 * It does NOT import `GitHubWriteModule`, and that is deliberate rather than
 * incidental: routing these writes through `guardedWrite` would put them under
 * `github.writesEnabled`, which governs whether the factory acts on issues
 * during a tick. Creating the taxonomy is operator setup and must work with
 * that switch off — otherwise the observation week cannot be set up without
 * enabling the writes it exists to withhold. See the service header.
 */
@Module({
  imports: [GitHubModule, GitHubReadModule],
  providers: [LabelProvisioningService],
  exports: [LabelProvisioningService],
})
export class LabelProvisioningModule {}
