import { Module } from '@nestjs/common';

import { LabelProvisioningModule } from '../github/labels/label-provisioning.module';
import { GitHubReadModule } from '../github/read/github-read.module';
import { AvailableRepositoriesService } from './available-repositories.service';
import { RepositoriesController } from './repositories.controller';
import { RepositoriesService } from './repositories.service';

/**
 * Read capability, plus exactly one narrow write: creating the factory labels.
 *
 * Registration verifies a repository is reachable, which is a read. It then
 * creates the label taxonomy on it, which is a write — and the imports say
 * precisely which write, because `LabelProvisioningModule` confers the ability
 * to create the fifteen declared labels and nothing else. That is the point of
 * #41 and #42 being separate modules rather than one service with a comment,
 * and the reason #415 followed `GitBranchModule` rather than importing
 * `GitHubWriteModule` here: importing the general write module would hand this
 * controller comments, issue creation and mirror-label writes it has no
 * business with.
 */
@Module({
  imports: [GitHubReadModule, LabelProvisioningModule],
  controllers: [RepositoriesController],
  providers: [RepositoriesService, AvailableRepositoriesService],
  exports: [RepositoriesService],
})
export class RepositoriesModule {}
