import { MockNgnProvider } from './mock-ngn.provider.js';

export class NombaNgnProvider extends MockNgnProvider {
  name = 'nomba' as const;
  async health() {
    return { provider: this.name, available: false, mode: 'live_disabled' as const, message: 'nomba adapter placeholder. Enable after provider approval.', checkedAt: new Date().toISOString() };
  }
}
