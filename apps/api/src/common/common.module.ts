import { Module } from '@nestjs/common';
import { AdminBootstrapService } from './services/admin-bootstrap.service';

@Module({
  providers: [AdminBootstrapService],
  exports: [AdminBootstrapService],
})
export class CommonModule {}
