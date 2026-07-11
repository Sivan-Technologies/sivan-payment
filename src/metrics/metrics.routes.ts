import type { FastifyInstance } from 'fastify';
import { getOnboardingCostSummary } from './onboarding-costs.service.js';

export async function metricsRoutes(app: FastifyInstance) {
  app.get('/api/metrics/onboarding-costs', async () => {
    return { data: await getOnboardingCostSummary() };
  });
}
