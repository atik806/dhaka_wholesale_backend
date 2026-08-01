import { Module, Global } from '@nestjs/common';
import { CacheStore } from './cache-store.js';

@Global()
@Module({
  providers: [CacheStore],
  exports: [CacheStore],
})
export class CacheModule {}
