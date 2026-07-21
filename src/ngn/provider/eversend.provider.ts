import { MockNgnProvider } from './mock-ngn.provider.js';

export class EversendNgnProvider extends MockNgnProvider {
  name = 'eversend' as const;
  async health() {
    return { provider: this.name, available: false, mode: 'live_disabled' as const, message: 'eversend adapter placeholder. Enable after provider approval.', checkedAt: new Date().toISOString() };
  }
}
