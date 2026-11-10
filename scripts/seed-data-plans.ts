/**
 * Seed live verified Nigerian mobile data bundle plans for MTN, Airtel, and Glo.
 *
 * Wholesale costs and providerPlanCodes are sourced directly from the live SME API
 * provider catalogue.
 *
 * Run: npx tsx scripts/seed-data-plans.ts
 */

import { updateUtilityDataPlans, UtilityDataPlanRecord } from '../src/ngn/service/utility-data-plans.service.js';

export const VERIFIED_DATA_PLANS = [
  // ── MTN Nigeria ─────────────────────────────────────────────────────────────
  // 1 Day
  { bundleSize: '500MB', costPriceNgn: 345, amountNgn: 390, network: 'mtn', validity: '1 Day', planType: 'Gifting', providerPlanCodes: { smeapi: '154' }, isActive: true },
  { bundleSize: '1GB', costPriceNgn: 493, amountNgn: 550, network: 'mtn', validity: '1 Day', planType: 'Gifting', providerPlanCodes: { smeapi: '156' }, isActive: true },
  { bundleSize: '2.5GB', costPriceNgn: 545, amountNgn: 600, network: 'mtn', validity: '1 Day', planType: 'Corporate2', providerPlanCodes: { smeapi: '207' }, isActive: true },
  // 2 Days
  { bundleSize: '1.5GB', costPriceNgn: 590, amountNgn: 650, network: 'mtn', validity: '2 Days', planType: 'Gifting', providerPlanCodes: { smeapi: '159' }, isActive: true },
  { bundleSize: '2GB', costPriceNgn: 738, amountNgn: 820, network: 'mtn', validity: '2 Days', planType: 'Gifting', providerPlanCodes: { smeapi: '164' }, isActive: true },
  { bundleSize: '2.5GB', costPriceNgn: 886, amountNgn: 980, network: 'mtn', validity: '2 Days', planType: 'Gifting', providerPlanCodes: { smeapi: '167' }, isActive: true },
  { bundleSize: '3.2GB', costPriceNgn: 986, amountNgn: 1100, network: 'mtn', validity: '2 Days', planType: 'Gifting', providerPlanCodes: { smeapi: '169' }, isActive: true },
  // 7 Days (Weekly)
  { bundleSize: '500MB', costPriceNgn: 200, amountNgn: 250, network: 'mtn', validity: '7 Days', planType: 'SME2', providerPlanCodes: { smeapi: '1' }, isActive: true },
  { bundleSize: '1GB', costPriceNgn: 370, amountNgn: 420, network: 'mtn', validity: '7 Days', planType: 'SME2', providerPlanCodes: { smeapi: '2' }, isActive: true },
  { bundleSize: '2GB', costPriceNgn: 685, amountNgn: 760, network: 'mtn', validity: '7 Days', planType: 'SME2', providerPlanCodes: { smeapi: '3' }, isActive: true },
  { bundleSize: '6GB', costPriceNgn: 2461, amountNgn: 2700, network: 'mtn', validity: '7 Days', planType: 'Gifting', providerPlanCodes: { smeapi: '171' }, isActive: true },
  // 30 Days (Monthly)
  { bundleSize: '1GB', costPriceNgn: 395, amountNgn: 450, network: 'mtn', validity: '30 Days', planType: 'SME2', providerPlanCodes: { smeapi: '6' }, isActive: true },
  { bundleSize: '2GB', costPriceNgn: 740, amountNgn: 830, network: 'mtn', validity: '30 Days', planType: 'SME', providerPlanCodes: { smeapi: '8' }, isActive: true },
  { bundleSize: '3GB', costPriceNgn: 1010, amountNgn: 1150, network: 'mtn', validity: '30 Days', planType: 'SME', providerPlanCodes: { smeapi: '7' }, isActive: true },
  { bundleSize: '5GB', costPriceNgn: 1500, amountNgn: 1750, network: 'mtn', validity: '30 Days', planType: 'Coupon', providerPlanCodes: { smeapi: '40' }, isActive: true },
  { bundleSize: '10GB', costPriceNgn: 2810, amountNgn: 3200, network: 'mtn', validity: '30 Days', planType: 'SME', providerPlanCodes: { smeapi: '46' }, isActive: true },
  { bundleSize: '15GB', costPriceNgn: 4211, amountNgn: 4750, network: 'mtn', validity: '30 Days', planType: 'SME', providerPlanCodes: { smeapi: '47' }, isActive: true },
  { bundleSize: '20GB', costPriceNgn: 5610, amountNgn: 6300, network: 'mtn', validity: '30 Days', planType: 'SME', providerPlanCodes: { smeapi: '48' }, isActive: true },

  // ── Airtel Nigeria ──────────────────────────────────────────────────────────
  // 1 Day
  { bundleSize: '1GB', costPriceNgn: 315, amountNgn: 360, network: 'airtel', validity: '1 Day', planType: 'Corporate2', providerPlanCodes: { smeapi: '74' }, isActive: true },
  { bundleSize: '1.5GB', costPriceNgn: 438, amountNgn: 500, network: 'airtel', validity: '1 Day', planType: 'SME', providerPlanCodes: { smeapi: '76' }, isActive: true },
  { bundleSize: '3GB', costPriceNgn: 750, amountNgn: 850, network: 'airtel', validity: '1 Day', planType: 'Coupon', providerPlanCodes: { smeapi: '306' }, isActive: true },
  // 2 Days
  { bundleSize: '2GB', costPriceNgn: 710, amountNgn: 800, network: 'airtel', validity: '2 Days', planType: 'SME', providerPlanCodes: { smeapi: '79' }, isActive: true },
  { bundleSize: '3GB', costPriceNgn: 740, amountNgn: 840, network: 'airtel', validity: '2 Days', planType: 'SME', providerPlanCodes: { smeapi: '81' }, isActive: true },
  // 7 Days (Weekly)
  { bundleSize: '1GB', costPriceNgn: 790, amountNgn: 880, network: 'airtel', validity: '7 Days', planType: 'Gifting', providerPlanCodes: { smeapi: '75' }, isActive: true },
  { bundleSize: '3GB', costPriceNgn: 1099, amountNgn: 1250, network: 'airtel', validity: '7 Days', planType: 'Corporate2', providerPlanCodes: { smeapi: '84' }, isActive: true },
  // 30 Days (Monthly)
  { bundleSize: '2GB', costPriceNgn: 1470, amountNgn: 1650, network: 'airtel', validity: '30 Days', planType: 'Corporate', providerPlanCodes: { smeapi: '80' }, isActive: true },
  { bundleSize: '3GB', costPriceNgn: 1975, amountNgn: 2200, network: 'airtel', validity: '30 Days', planType: 'Coupon', providerPlanCodes: { smeapi: '323' }, isActive: true },
  { bundleSize: '4GB', costPriceNgn: 2470, amountNgn: 2750, network: 'airtel', validity: '30 Days', planType: 'Coupon', providerPlanCodes: { smeapi: '324' }, isActive: true },
  { bundleSize: '10GB', costPriceNgn: 3250, amountNgn: 3600, network: 'airtel', validity: '30 Days', planType: 'Coupon', providerPlanCodes: { smeapi: '314' }, isActive: true },

  // ── Glo Nigeria ─────────────────────────────────────────────────────────────
  // 1 Day
  { bundleSize: '1GB', costPriceNgn: 346, amountNgn: 390, network: 'glo', validity: '1 Day', planType: 'SME', providerPlanCodes: { smeapi: '116' }, isActive: true },
  { bundleSize: '1.5GB', costPriceNgn: 300, amountNgn: 350, network: 'glo', validity: '1 Day', planType: 'Share', providerPlanCodes: { smeapi: '118' }, isActive: true },
  { bundleSize: '2GB', costPriceNgn: 490, amountNgn: 550, network: 'glo', validity: '1 Day', planType: 'SME', providerPlanCodes: { smeapi: '119' }, isActive: true },
  // 2 Days
  { bundleSize: '2.5GB', costPriceNgn: 480, amountNgn: 550, network: 'glo', validity: '2 Days', planType: 'Share', providerPlanCodes: { smeapi: '121' }, isActive: true },
  // 7 Days (Weekly)
  { bundleSize: '1GB', costPriceNgn: 367, amountNgn: 420, network: 'glo', validity: '7 Days', planType: 'Gifting', providerPlanCodes: { smeapi: '114' }, isActive: true },
  { bundleSize: '5GB', costPriceNgn: 1625, amountNgn: 1800, network: 'glo', validity: '7 Days', planType: 'Gifting', providerPlanCodes: { smeapi: '127' }, isActive: true },
  { bundleSize: '10GB', costPriceNgn: 1900, amountNgn: 2100, network: 'glo', validity: '7 Days', planType: 'Share', providerPlanCodes: { smeapi: '130' }, isActive: true },
  // 14 Days
  { bundleSize: '200MB', costPriceNgn: 91, amountNgn: 150, network: 'glo', validity: '14 Days', planType: 'SME', providerPlanCodes: { smeapi: '110' }, isActive: true },
  { bundleSize: '5GB', costPriceNgn: 1675, amountNgn: 1850, network: 'glo', validity: '14 Days', planType: 'Gifting', providerPlanCodes: { smeapi: '128' }, isActive: true },
  { bundleSize: '10GB', costPriceNgn: 3350, amountNgn: 3700, network: 'glo', validity: '14 Days', planType: 'Gifting', providerPlanCodes: { smeapi: '132' }, isActive: true },
  // 30 Days (Monthly)
  { bundleSize: '1GB', costPriceNgn: 398, amountNgn: 450, network: 'glo', validity: '30 Days', planType: 'Corporate', providerPlanCodes: { smeapi: '117' }, isActive: true },
  { bundleSize: '2GB', costPriceNgn: 796, amountNgn: 900, network: 'glo', validity: '30 Days', planType: 'Corporate', providerPlanCodes: { smeapi: '120' }, isActive: true },
  { bundleSize: '3GB', costPriceNgn: 1194, amountNgn: 1350, network: 'glo', validity: '30 Days', planType: 'Corporate', providerPlanCodes: { smeapi: '125' }, isActive: true },
  { bundleSize: '5GB', costPriceNgn: 1990, amountNgn: 2250, network: 'glo', validity: '30 Days', planType: 'Corporate', providerPlanCodes: { smeapi: '129' }, isActive: true },
  { bundleSize: '10GB', costPriceNgn: 2935, amountNgn: 3300, network: 'glo', validity: '30 Days', planType: 'Corporate', providerPlanCodes: { smeapi: '333' }, isActive: true },
  { bundleSize: '20GB', costPriceNgn: 5680, amountNgn: 6400, network: 'glo', validity: '30 Days', planType: 'Corporate', providerPlanCodes: { smeapi: '136' }, isActive: true },
];

async function seed() {
  console.log(`Seeding ${VERIFIED_DATA_PLANS.length} verified data plans...`);
  const updated = await updateUtilityDataPlans(VERIFIED_DATA_PLANS, 'admin_system_seed', { replaceAll: true });
  console.log(`Successfully seeded ${updated.length} plans.`);
}

if (process.argv[1]?.endsWith('seed-data-plans.ts')) {
  seed().catch((err) => {
    console.error('Seed error:', err);
    process.exit(1);
  });
}
