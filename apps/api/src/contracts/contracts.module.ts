import { Global, Module } from '@nestjs/common';

import { ContractValidator } from './contract-validator';

/**
 * The schema validators, available anywhere a document enters the system.
 *
 * `@Global` because the boundaries are spread across modules that have nothing
 * else to do with each other — runner registration, work-order construction —
 * and threading an import through each of them would make adding the next
 * boundary a module-graph change rather than one line. The module holds one
 * stateless provider whose whole job is being shared.
 */
@Global()
@Module({
  providers: [ContractValidator],
  exports: [ContractValidator],
})
export class ContractsModule {}
