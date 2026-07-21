import { MockNgnProvider } from './mock-ngn.provider.js';

export class LinkioNgnProvider extends MockNgnProvider {
  name = 'linkio' as const;
  async health() {
    return { provider: this.name, available: false, mode: 'live_disabled' as const, message: 'linkio adapter placeholder. Enable after provider approval.', checkedAt: new Date().toISOString() };
  }
}
