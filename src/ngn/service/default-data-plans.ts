/**
 * Pre-seeded, authentic data plan catalogue from live providers (SMEAPI and Paystack).
 * Categorized across Daily (1 Day), 2 Days, 3 Days, Weekly (7 Days), 14 Days, and Monthly (30 Days).
 */
import type { UtilityDataPlanRecord } from "./utility-data-plans.service.js";

export const DEFAULT_DATA_PLANS: UtilityDataPlanRecord[] = [
  {
    "id": "plan_mtn_500mb_7days_1",
    "bundleSize": "500MB",
    "costPriceNgn": 220,
    "markupNgn": 30,
    "amountNgn": 250,
    "network": "mtn",
    "isActive": true,
    "planCode": "DATA_MTN_500MB_7DAYS",
    "providerPlanCodes": {
      "smeapi": "1"
    },
    "planType": "SME2",
    "validity": "7 Days",
    "description": "500MB Mobile Data (MTN . 7 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_mtn_1gb_7days_2",
    "bundleSize": "1GB",
    "costPriceNgn": 380,
    "markupNgn": 50,
    "amountNgn": 430,
    "network": "mtn",
    "isActive": true,
    "planCode": "DATA_MTN_1GB_7DAYS",
    "providerPlanCodes": {
      "smeapi": "2"
    },
    "planType": "SME2",
    "validity": "7 Days",
    "description": "1GB Mobile Data (MTN . 7 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_mtn_2gb_7days_3",
    "bundleSize": "2GB",
    "costPriceNgn": 740,
    "markupNgn": 50,
    "amountNgn": 790,
    "network": "mtn",
    "isActive": true,
    "planCode": "DATA_MTN_2GB_7DAYS",
    "providerPlanCodes": {
      "smeapi": "3"
    },
    "planType": "Corporate",
    "validity": "7 Days",
    "description": "2GB Mobile Data (MTN . 7 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_mtn_3gb_7days_4",
    "bundleSize": "3GB",
    "costPriceNgn": 995,
    "markupNgn": 50,
    "amountNgn": 1045,
    "network": "mtn",
    "isActive": true,
    "planCode": "DATA_MTN_3GB_7DAYS",
    "providerPlanCodes": {
      "smeapi": "4"
    },
    "planType": "SME2",
    "validity": "7 Days",
    "description": "3GB Mobile Data (MTN . 7 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_mtn_1gb_30days_6",
    "bundleSize": "1GB",
    "costPriceNgn": 480,
    "markupNgn": 50,
    "amountNgn": 530,
    "network": "mtn",
    "isActive": true,
    "planCode": "DATA_MTN_1GB_30DAYS",
    "providerPlanCodes": {
      "smeapi": "6"
    },
    "planType": "SME",
    "validity": "30 Days",
    "description": "1GB Mobile Data (MTN . 30 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_mtn_3gb_30days_7",
    "bundleSize": "3GB",
    "costPriceNgn": 1200,
    "markupNgn": 100,
    "amountNgn": 1300,
    "network": "mtn",
    "isActive": true,
    "planCode": "DATA_MTN_3GB_30DAYS",
    "providerPlanCodes": {
      "smeapi": "7"
    },
    "planType": "SME",
    "validity": "30 Days",
    "description": "3GB Mobile Data (MTN . 30 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_mtn_2gb_30days_8",
    "bundleSize": "2GB",
    "costPriceNgn": 765,
    "markupNgn": 50,
    "amountNgn": 815,
    "network": "mtn",
    "isActive": true,
    "planCode": "DATA_MTN_2GB_30DAYS",
    "providerPlanCodes": {
      "smeapi": "8"
    },
    "planType": "SME",
    "validity": "30 Days",
    "description": "2GB Mobile Data (MTN . 30 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_mtn_5gb_30days_40",
    "bundleSize": "5GB",
    "costPriceNgn": 1550,
    "markupNgn": 100,
    "amountNgn": 1650,
    "network": "mtn",
    "isActive": true,
    "planCode": "DATA_MTN_5GB_30DAYS",
    "providerPlanCodes": {
      "smeapi": "40"
    },
    "planType": "Coupon",
    "validity": "30 Days",
    "description": "5GB Mobile Data (MTN . 30 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_mtn_10gb_30days_46",
    "bundleSize": "10GB",
    "costPriceNgn": 3600,
    "markupNgn": 150,
    "amountNgn": 3750,
    "network": "mtn",
    "isActive": true,
    "planCode": "DATA_MTN_10GB_30DAYS",
    "providerPlanCodes": {
      "smeapi": "46"
    },
    "planType": "SME",
    "validity": "30 Days",
    "description": "10GB Mobile Data (MTN . 30 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_mtn_15gb_30days_47",
    "bundleSize": "15GB",
    "costPriceNgn": 5200,
    "markupNgn": 150,
    "amountNgn": 5350,
    "network": "mtn",
    "isActive": true,
    "planCode": "DATA_MTN_15GB_30DAYS",
    "providerPlanCodes": {
      "smeapi": "47"
    },
    "planType": "SME",
    "validity": "30 Days",
    "description": "15GB Mobile Data (MTN . 30 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_mtn_20gb_30days_48",
    "bundleSize": "20GB",
    "costPriceNgn": 7000,
    "markupNgn": 150,
    "amountNgn": 7150,
    "network": "mtn",
    "isActive": true,
    "planCode": "DATA_MTN_20GB_30DAYS",
    "providerPlanCodes": {
      "smeapi": "48"
    },
    "planType": "SME",
    "validity": "30 Days",
    "description": "20GB Mobile Data (MTN . 30 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_mtn_75mb_1day_150",
    "bundleSize": "75MB",
    "costPriceNgn": 78,
    "markupNgn": 30,
    "amountNgn": 108,
    "network": "mtn",
    "isActive": true,
    "planCode": "DATA_MTN_75MB_1DAY",
    "providerPlanCodes": {
      "smeapi": "150"
    },
    "planType": "Gifting",
    "validity": "1 Day",
    "description": "75MB Mobile Data (MTN . 1 Day)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_mtn_110mb_1day_151",
    "bundleSize": "110MB",
    "costPriceNgn": 102,
    "markupNgn": 30,
    "amountNgn": 132,
    "network": "mtn",
    "isActive": true,
    "planCode": "DATA_MTN_110MB_1DAY",
    "providerPlanCodes": {
      "smeapi": "151"
    },
    "planType": "Gifting",
    "validity": "1 Day",
    "description": "110MB Mobile Data (MTN . 1 Day)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_mtn_500mb_1day_154",
    "bundleSize": "500MB",
    "costPriceNgn": 345,
    "markupNgn": 50,
    "amountNgn": 395,
    "network": "mtn",
    "isActive": true,
    "planCode": "DATA_MTN_500MB_1DAY",
    "providerPlanCodes": {
      "smeapi": "154"
    },
    "planType": "Gifting",
    "validity": "1 Day",
    "description": "500MB Mobile Data (MTN . 1 Day)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_mtn_500mb_30days_155",
    "bundleSize": "500MB",
    "costPriceNgn": 250,
    "markupNgn": 30,
    "amountNgn": 280,
    "network": "mtn",
    "isActive": true,
    "planCode": "DATA_MTN_500MB_30DAYS",
    "providerPlanCodes": {
      "smeapi": "155"
    },
    "planType": "SME",
    "validity": "30 Days",
    "description": "500MB Mobile Data (MTN . 30 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_mtn_1gb_1day_156",
    "bundleSize": "1GB",
    "costPriceNgn": 493,
    "markupNgn": 50,
    "amountNgn": 543,
    "network": "mtn",
    "isActive": true,
    "planCode": "DATA_MTN_1GB_1DAY",
    "providerPlanCodes": {
      "smeapi": "156"
    },
    "planType": "Gifting",
    "validity": "1 Day",
    "description": "1GB Mobile Data (MTN . 1 Day)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_mtn_1.5gb_2days_159",
    "bundleSize": "1.5GB",
    "costPriceNgn": 590,
    "markupNgn": 50,
    "amountNgn": 640,
    "network": "mtn",
    "isActive": true,
    "planCode": "DATA_MTN_1.5GB_2DAYS",
    "providerPlanCodes": {
      "smeapi": "159"
    },
    "planType": "Gifting",
    "validity": "2 Days",
    "description": "1.5GB Mobile Data (MTN . 2 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_mtn_1.8gb_other_161",
    "bundleSize": "1.8GB",
    "costPriceNgn": 1464,
    "markupNgn": 100,
    "amountNgn": 1564,
    "network": "mtn",
    "isActive": true,
    "planCode": "DATA_MTN_1.8GB_OTHER",
    "providerPlanCodes": {
      "smeapi": "161"
    },
    "planType": "Gifting",
    "validity": "35 Minutes Call + 1.8GB Data",
    "description": "1.8GB Mobile Data (MTN . 35 Minutes Call + 1.8GB Data)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_mtn_1.0gb_2days_162",
    "bundleSize": "1.0GB",
    "costPriceNgn": 739,
    "markupNgn": 50,
    "amountNgn": 789,
    "network": "mtn",
    "isActive": true,
    "planCode": "DATA_MTN_1.0GB_2DAYS",
    "providerPlanCodes": {
      "smeapi": "162"
    },
    "planType": "Gifting",
    "validity": "2 Days",
    "description": "1.0GB Mobile Data (MTN . 2 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_mtn_2gb_2days_164",
    "bundleSize": "2GB",
    "costPriceNgn": 738,
    "markupNgn": 50,
    "amountNgn": 788,
    "network": "mtn",
    "isActive": true,
    "planCode": "DATA_MTN_2GB_2DAYS",
    "providerPlanCodes": {
      "smeapi": "164"
    },
    "planType": "Gifting",
    "validity": "2 Days",
    "description": "2GB Mobile Data (MTN . 2 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_mtn_2.5gb_1day_165",
    "bundleSize": "2.5GB",
    "costPriceNgn": 742,
    "markupNgn": 50,
    "amountNgn": 792,
    "network": "mtn",
    "isActive": true,
    "planCode": "DATA_MTN_2.5GB_1DAY",
    "providerPlanCodes": {
      "smeapi": "165"
    },
    "planType": "Gifting",
    "validity": "1 Day",
    "description": "2.5GB Mobile Data (MTN . 1 Day)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_mtn_2.5gb_2days_166",
    "bundleSize": "2.5GB",
    "costPriceNgn": 888,
    "markupNgn": 50,
    "amountNgn": 938,
    "network": "mtn",
    "isActive": true,
    "planCode": "DATA_MTN_2.5GB_2DAYS",
    "providerPlanCodes": {
      "smeapi": "166"
    },
    "planType": "Gifting",
    "validity": "2 Days",
    "description": "2.5GB Mobile Data (MTN . 2 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_mtn_3.2gb_2days_168",
    "bundleSize": "3.2GB",
    "costPriceNgn": 989,
    "markupNgn": 50,
    "amountNgn": 1039,
    "network": "mtn",
    "isActive": true,
    "planCode": "DATA_MTN_3.2GB_2DAYS",
    "providerPlanCodes": {
      "smeapi": "168"
    },
    "planType": "Gifting",
    "validity": "2 Days",
    "description": "3.2GB Mobile Data (MTN . 2 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_mtn_3.5gb_30days_170",
    "bundleSize": "3.5GB",
    "costPriceNgn": 2443,
    "markupNgn": 100,
    "amountNgn": 2543,
    "network": "mtn",
    "isActive": true,
    "planCode": "DATA_MTN_3.5GB_30DAYS",
    "providerPlanCodes": {
      "smeapi": "170"
    },
    "planType": "Gifting",
    "validity": "30 Days",
    "description": "3.5GB Mobile Data (MTN . 30 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_mtn_6gb_7days_171",
    "bundleSize": "6GB",
    "costPriceNgn": 2461,
    "markupNgn": 100,
    "amountNgn": 2561,
    "network": "mtn",
    "isActive": true,
    "planCode": "DATA_MTN_6GB_7DAYS",
    "providerPlanCodes": {
      "smeapi": "171"
    },
    "planType": "Gifting",
    "validity": "7 Days",
    "description": "6GB Mobile Data (MTN . 7 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_mtn_11gb_7days_172",
    "bundleSize": "11GB",
    "costPriceNgn": 3459,
    "markupNgn": 150,
    "amountNgn": 3609,
    "network": "mtn",
    "isActive": true,
    "planCode": "DATA_MTN_11GB_7DAYS",
    "providerPlanCodes": {
      "smeapi": "172"
    },
    "planType": "Gifting",
    "validity": "7 Days",
    "description": "11GB Mobile Data (MTN . 7 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_mtn_12.5gb_30days_174",
    "bundleSize": "12.5GB",
    "costPriceNgn": 5398,
    "markupNgn": 150,
    "amountNgn": 5548,
    "network": "mtn",
    "isActive": true,
    "planCode": "DATA_MTN_12.5GB_30DAYS",
    "providerPlanCodes": {
      "smeapi": "174"
    },
    "planType": "Gifting",
    "validity": "30 Days",
    "description": "12.5GB Mobile Data (MTN . 30 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_mtn_3.0gb_30days_175",
    "bundleSize": "3.0GB",
    "costPriceNgn": 6404,
    "markupNgn": 150,
    "amountNgn": 6554,
    "network": "mtn",
    "isActive": true,
    "planCode": "DATA_MTN_3.0GB_30DAYS",
    "providerPlanCodes": {
      "smeapi": "175"
    },
    "planType": "Gifting",
    "validity": "30 Days",
    "description": "3.0GB Mobile Data (MTN . 30 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_mtn_20gb_7days_176",
    "bundleSize": "20GB",
    "costPriceNgn": 5100,
    "markupNgn": 150,
    "amountNgn": 5250,
    "network": "mtn",
    "isActive": true,
    "planCode": "DATA_MTN_20GB_7DAYS",
    "providerPlanCodes": {
      "smeapi": "176"
    },
    "planType": "Gifting",
    "validity": "7 Days",
    "description": "20GB Mobile Data (MTN . 7 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_mtn_75gb_30days_177",
    "bundleSize": "75GB",
    "costPriceNgn": 17880,
    "markupNgn": 150,
    "amountNgn": 18030,
    "network": "mtn",
    "isActive": true,
    "planCode": "DATA_MTN_75GB_30DAYS",
    "providerPlanCodes": {
      "smeapi": "177"
    },
    "planType": "Gifting",
    "validity": "30 Days",
    "description": "75GB Mobile Data (MTN . 30 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_mtn_200gb_other_178",
    "bundleSize": "200GB",
    "costPriceNgn": 52550,
    "markupNgn": 150,
    "amountNgn": 52700,
    "network": "mtn",
    "isActive": true,
    "planCode": "DATA_MTN_200GB_OTHER",
    "providerPlanCodes": {
      "smeapi": "178"
    },
    "planType": "Gifting",
    "validity": "60 Days",
    "description": "200GB Mobile Data (MTN . 60 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_75mb_1day_60",
    "bundleSize": "75MB",
    "costPriceNgn": 78,
    "markupNgn": 30,
    "amountNgn": 108,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_75MB_1DAY",
    "providerPlanCodes": {
      "smeapi": "60"
    },
    "planType": "SME",
    "validity": "1 Day",
    "description": "75MB Mobile Data (AIRTEL . 1 Day)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_100mb_1day_61",
    "bundleSize": "100MB",
    "costPriceNgn": 110,
    "markupNgn": 30,
    "amountNgn": 140,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_100MB_1DAY",
    "providerPlanCodes": {
      "smeapi": "61"
    },
    "planType": "SME",
    "validity": "1 Day",
    "description": "100MB Mobile Data (AIRTEL . 1 Day)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_110mb_1day_62",
    "bundleSize": "110MB",
    "costPriceNgn": 103,
    "markupNgn": 30,
    "amountNgn": 133,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_110MB_1DAY",
    "providerPlanCodes": {
      "smeapi": "62"
    },
    "planType": "SME",
    "validity": "1 Day",
    "description": "110MB Mobile Data (AIRTEL . 1 Day)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_150mb_1day_63",
    "bundleSize": "150MB",
    "costPriceNgn": 60,
    "markupNgn": 30,
    "amountNgn": 90,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_150MB_1DAY",
    "providerPlanCodes": {
      "smeapi": "63"
    },
    "planType": "SME",
    "validity": "1 Day",
    "description": "150MB Mobile Data (AIRTEL . 1 Day)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_230mb_2days_64",
    "bundleSize": "230MB",
    "costPriceNgn": 192,
    "markupNgn": 30,
    "amountNgn": 222,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_230MB_2DAYS",
    "providerPlanCodes": {
      "smeapi": "64"
    },
    "planType": "SME",
    "validity": "2 Days",
    "description": "230MB Mobile Data (AIRTEL . 2 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_300mb_2days_66",
    "bundleSize": "300MB",
    "costPriceNgn": 120,
    "markupNgn": 30,
    "amountNgn": 150,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_300MB_2DAYS",
    "providerPlanCodes": {
      "smeapi": "66"
    },
    "planType": "SME",
    "validity": "2 Days",
    "description": "300MB Mobile Data (AIRTEL . 2 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_500mb_7days_68",
    "bundleSize": "500MB",
    "costPriceNgn": 497,
    "markupNgn": 50,
    "amountNgn": 547,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_500MB_7DAYS",
    "providerPlanCodes": {
      "smeapi": "68"
    },
    "planType": "Gifting",
    "validity": "7 Days",
    "description": "500MB Mobile Data (AIRTEL . 7 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_600mb_1day_70",
    "bundleSize": "600MB",
    "costPriceNgn": 225,
    "markupNgn": 30,
    "amountNgn": 255,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_600MB_1DAY",
    "providerPlanCodes": {
      "smeapi": "70"
    },
    "planType": "SME",
    "validity": "1 Day",
    "description": "600MB Mobile Data (AIRTEL . 1 Day)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_1gb_3days_71",
    "bundleSize": "1GB",
    "costPriceNgn": 305,
    "markupNgn": 50,
    "amountNgn": 355,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_1GB_3DAYS",
    "providerPlanCodes": {
      "smeapi": "71"
    },
    "planType": "SME",
    "validity": "3 Days",
    "description": "1GB Mobile Data (AIRTEL . 3 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_300.0mb_2days_73",
    "bundleSize": "300.0MB",
    "costPriceNgn": 305,
    "markupNgn": 50,
    "amountNgn": 355,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_300.0MB_2DAYS",
    "providerPlanCodes": {
      "smeapi": "73"
    },
    "planType": "SME",
    "validity": "2 Days",
    "description": "300.0MB Mobile Data (AIRTEL . 2 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_1gb_1day_74",
    "bundleSize": "1GB",
    "costPriceNgn": 315,
    "markupNgn": 50,
    "amountNgn": 365,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_1GB_1DAY",
    "providerPlanCodes": {
      "smeapi": "74"
    },
    "planType": "Corporate2",
    "validity": "1 Day",
    "description": "1GB Mobile Data (AIRTEL . 1 Day)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_1gb_7days_75",
    "bundleSize": "1GB",
    "costPriceNgn": 800,
    "markupNgn": 50,
    "amountNgn": 850,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_1GB_7DAYS",
    "providerPlanCodes": {
      "smeapi": "75"
    },
    "planType": "Gifting",
    "validity": "7 Days",
    "description": "1GB Mobile Data (AIRTEL . 7 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_1.5gb_1day_76",
    "bundleSize": "1.5GB",
    "costPriceNgn": 438,
    "markupNgn": 50,
    "amountNgn": 488,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_1.5GB_1DAY",
    "providerPlanCodes": {
      "smeapi": "76"
    },
    "planType": "SME",
    "validity": "1 Day",
    "description": "1.5GB Mobile Data (AIRTEL . 1 Day)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_1.5gb_7days_77",
    "bundleSize": "1.5GB",
    "costPriceNgn": 493,
    "markupNgn": 50,
    "amountNgn": 543,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_1.5GB_7DAYS",
    "providerPlanCodes": {
      "smeapi": "77"
    },
    "planType": "Gifting",
    "validity": "7 Days",
    "description": "1.5GB Mobile Data (AIRTEL . 7 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_2gb_2days_79",
    "bundleSize": "2GB",
    "costPriceNgn": 710,
    "markupNgn": 50,
    "amountNgn": 760,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_2GB_2DAYS",
    "providerPlanCodes": {
      "smeapi": "79"
    },
    "planType": "SME",
    "validity": "2 Days",
    "description": "2GB Mobile Data (AIRTEL . 2 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_2gb_30days_80",
    "bundleSize": "2GB",
    "costPriceNgn": 1470,
    "markupNgn": 100,
    "amountNgn": 1570,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_2GB_30DAYS",
    "providerPlanCodes": {
      "smeapi": "80"
    },
    "planType": "Corporate",
    "validity": "30 Days",
    "description": "2GB Mobile Data (AIRTEL . 30 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_3gb_2days_81",
    "bundleSize": "3GB",
    "costPriceNgn": 740,
    "markupNgn": 50,
    "amountNgn": 790,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_3GB_2DAYS",
    "providerPlanCodes": {
      "smeapi": "81"
    },
    "planType": "SME",
    "validity": "2 Days",
    "description": "3GB Mobile Data (AIRTEL . 2 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_3gb_7days_84",
    "bundleSize": "3GB",
    "costPriceNgn": 1099,
    "markupNgn": 100,
    "amountNgn": 1199,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_3GB_7DAYS",
    "providerPlanCodes": {
      "smeapi": "84"
    },
    "planType": "Corporate2",
    "validity": "7 Days",
    "description": "3GB Mobile Data (AIRTEL . 7 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_3gb_30days_85",
    "bundleSize": "3GB",
    "costPriceNgn": 1875,
    "markupNgn": 100,
    "amountNgn": 1975,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_3GB_30DAYS",
    "providerPlanCodes": {
      "smeapi": "85"
    },
    "planType": "Corporate",
    "validity": "30 Days",
    "description": "3GB Mobile Data (AIRTEL . 30 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_4gb_7days_86",
    "bundleSize": "4GB",
    "costPriceNgn": 1470,
    "markupNgn": 100,
    "amountNgn": 1570,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_4GB_7DAYS",
    "providerPlanCodes": {
      "smeapi": "86"
    },
    "planType": "Gifting",
    "validity": "7 Days",
    "description": "4GB Mobile Data (AIRTEL . 7 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_4gb_30days_87",
    "bundleSize": "4GB",
    "costPriceNgn": 2345,
    "markupNgn": 100,
    "amountNgn": 2445,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_4GB_30DAYS",
    "providerPlanCodes": {
      "smeapi": "87"
    },
    "planType": "Corporate",
    "validity": "30 Days",
    "description": "4GB Mobile Data (AIRTEL . 30 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_6gb_7days_89",
    "bundleSize": "6GB",
    "costPriceNgn": 2355,
    "markupNgn": 100,
    "amountNgn": 2455,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_6GB_7DAYS",
    "providerPlanCodes": {
      "smeapi": "89"
    },
    "planType": "Gifting",
    "validity": "7 Days",
    "description": "6GB Mobile Data (AIRTEL . 7 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_8.0gb_30days_91",
    "bundleSize": "8.0GB",
    "costPriceNgn": 2830,
    "markupNgn": 100,
    "amountNgn": 2930,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_8.0GB_30DAYS",
    "providerPlanCodes": {
      "smeapi": "91"
    },
    "planType": "Corporate",
    "validity": "30 Days",
    "description": "8.0GB Mobile Data (AIRTEL . 30 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_8gb_30days_92",
    "bundleSize": "8GB",
    "costPriceNgn": 2830,
    "markupNgn": 100,
    "amountNgn": 2930,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_8GB_30DAYS",
    "providerPlanCodes": {
      "smeapi": "92"
    },
    "planType": "Corporate",
    "validity": "30 Days",
    "description": "8GB Mobile Data (AIRTEL . 30 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_10gb_7days_93",
    "bundleSize": "10GB",
    "costPriceNgn": 2840,
    "markupNgn": 100,
    "amountNgn": 2940,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_10GB_7DAYS",
    "providerPlanCodes": {
      "smeapi": "93"
    },
    "planType": "Gifting",
    "validity": "7 Days",
    "description": "10GB Mobile Data (AIRTEL . 7 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_10gb_30days_94",
    "bundleSize": "10GB",
    "costPriceNgn": 3100,
    "markupNgn": 150,
    "amountNgn": 3250,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_10GB_30DAYS",
    "providerPlanCodes": {
      "smeapi": "94"
    },
    "planType": "Corporate",
    "validity": "30 Days",
    "description": "10GB Mobile Data (AIRTEL . 30 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_13.0gb_30days_96",
    "bundleSize": "13.0GB",
    "costPriceNgn": 4715,
    "markupNgn": 150,
    "amountNgn": 4865,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_13.0GB_30DAYS",
    "providerPlanCodes": {
      "smeapi": "96"
    },
    "planType": "Corporate",
    "validity": "30 Days",
    "description": "13.0GB Mobile Data (AIRTEL . 30 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_13gb_30days_97",
    "bundleSize": "13GB",
    "costPriceNgn": 4715,
    "markupNgn": 150,
    "amountNgn": 4865,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_13GB_30DAYS",
    "providerPlanCodes": {
      "smeapi": "97"
    },
    "planType": "Corporate",
    "validity": "30 Days",
    "description": "13GB Mobile Data (AIRTEL . 30 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_18gb_7days_98",
    "bundleSize": "18GB",
    "costPriceNgn": 4940,
    "markupNgn": 150,
    "amountNgn": 5090,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_18GB_7DAYS",
    "providerPlanCodes": {
      "smeapi": "98"
    },
    "planType": "Gifting",
    "validity": "7 Days",
    "description": "18GB Mobile Data (AIRTEL . 7 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_18gb_30days_100",
    "bundleSize": "18GB",
    "costPriceNgn": 5670,
    "markupNgn": 150,
    "amountNgn": 5820,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_18GB_30DAYS",
    "providerPlanCodes": {
      "smeapi": "100"
    },
    "planType": "Corporate",
    "validity": "30 Days",
    "description": "18GB Mobile Data (AIRTEL . 30 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_25gb_30days_102",
    "bundleSize": "25GB",
    "costPriceNgn": 7565,
    "markupNgn": 150,
    "amountNgn": 7715,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_25GB_30DAYS",
    "providerPlanCodes": {
      "smeapi": "102"
    },
    "planType": "Corporate",
    "validity": "30 Days",
    "description": "25GB Mobile Data (AIRTEL . 30 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_35gb_30days_104",
    "bundleSize": "35GB",
    "costPriceNgn": 9875,
    "markupNgn": 150,
    "amountNgn": 10025,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_35GB_30DAYS",
    "providerPlanCodes": {
      "smeapi": "104"
    },
    "planType": "Corporate",
    "validity": "30 Days",
    "description": "35GB Mobile Data (AIRTEL . 30 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_60gb_30days_106",
    "bundleSize": "60GB",
    "costPriceNgn": 14850,
    "markupNgn": 150,
    "amountNgn": 15000,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_60GB_30DAYS",
    "providerPlanCodes": {
      "smeapi": "106"
    },
    "planType": "Corporate",
    "validity": "30 Days",
    "description": "60GB Mobile Data (AIRTEL . 30 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_60gb_7days_107",
    "bundleSize": "60GB",
    "costPriceNgn": 14850,
    "markupNgn": 150,
    "amountNgn": 15000,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_60GB_7DAYS",
    "providerPlanCodes": {
      "smeapi": "107"
    },
    "planType": "Gifting",
    "validity": "7 Days",
    "description": "60GB Mobile Data (AIRTEL . 7 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_100gb_30days_108",
    "bundleSize": "100GB",
    "costPriceNgn": 19900,
    "markupNgn": 150,
    "amountNgn": 20050,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_100GB_30DAYS",
    "providerPlanCodes": {
      "smeapi": "108"
    },
    "planType": "Corporate",
    "validity": "30 Days",
    "description": "100GB Mobile Data (AIRTEL . 30 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_150.0mb_1day_300",
    "bundleSize": "150.0MB",
    "costPriceNgn": 60,
    "markupNgn": 30,
    "amountNgn": 90,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_150.0MB_1DAY",
    "providerPlanCodes": {
      "smeapi": "300"
    },
    "planType": "Coupon",
    "validity": "1 Day",
    "description": "150.0MB Mobile Data (AIRTEL . 1 Day)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_75.0mb_1day_304",
    "bundleSize": "75.0MB",
    "costPriceNgn": 83,
    "markupNgn": 30,
    "amountNgn": 113,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_75.0MB_1DAY",
    "providerPlanCodes": {
      "smeapi": "304"
    },
    "planType": "Coupon",
    "validity": "1 Day",
    "description": "75.0MB Mobile Data (AIRTEL . 1 Day)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_100.0mb_1day_305",
    "bundleSize": "100.0MB",
    "costPriceNgn": 105,
    "markupNgn": 30,
    "amountNgn": 135,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_100.0MB_1DAY",
    "providerPlanCodes": {
      "smeapi": "305"
    },
    "planType": "Coupon",
    "validity": "1 Day",
    "description": "100.0MB Mobile Data (AIRTEL . 1 Day)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_3.0gb_1day_306",
    "bundleSize": "3.0GB",
    "costPriceNgn": 750,
    "markupNgn": 50,
    "amountNgn": 800,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_3.0GB_1DAY",
    "providerPlanCodes": {
      "smeapi": "306"
    },
    "planType": "Coupon",
    "validity": "1 Day",
    "description": "3.0GB Mobile Data (AIRTEL . 1 Day)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_200.0mb_2days_307",
    "bundleSize": "200.0MB",
    "costPriceNgn": 205,
    "markupNgn": 30,
    "amountNgn": 235,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_200.0MB_2DAYS",
    "providerPlanCodes": {
      "smeapi": "307"
    },
    "planType": "Coupon",
    "validity": "2 Days",
    "description": "200.0MB Mobile Data (AIRTEL . 2 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_3.0gb_2days_309",
    "bundleSize": "3.0GB",
    "costPriceNgn": 750,
    "markupNgn": 50,
    "amountNgn": 800,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_3.0GB_2DAYS",
    "providerPlanCodes": {
      "smeapi": "309"
    },
    "planType": "Coupon",
    "validity": "2 Days",
    "description": "3.0GB Mobile Data (AIRTEL . 2 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_500.0mb_7days_312",
    "bundleSize": "500.0MB",
    "costPriceNgn": 495,
    "markupNgn": 50,
    "amountNgn": 545,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_500.0MB_7DAYS",
    "providerPlanCodes": {
      "smeapi": "312"
    },
    "planType": "Coupon",
    "validity": "7 Days",
    "description": "500.0MB Mobile Data (AIRTEL . 7 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_1.0gb_7days_313",
    "bundleSize": "1.0GB",
    "costPriceNgn": 789,
    "markupNgn": 50,
    "amountNgn": 839,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_1.0GB_7DAYS",
    "providerPlanCodes": {
      "smeapi": "313"
    },
    "planType": "Coupon",
    "validity": "7 Days",
    "description": "1.0GB Mobile Data (AIRTEL . 7 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_10.0gb_30days_314",
    "bundleSize": "10.0GB",
    "costPriceNgn": 3250,
    "markupNgn": 150,
    "amountNgn": 3400,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_10.0GB_30DAYS",
    "providerPlanCodes": {
      "smeapi": "314"
    },
    "planType": "Coupon",
    "validity": "30 Days",
    "description": "10.0GB Mobile Data (AIRTEL . 30 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_35.0gb_30days_318",
    "bundleSize": "35.0GB",
    "costPriceNgn": 10125,
    "markupNgn": 150,
    "amountNgn": 10275,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_35.0GB_30DAYS",
    "providerPlanCodes": {
      "smeapi": "318"
    },
    "planType": "Coupon",
    "validity": "30 Days",
    "description": "35.0GB Mobile Data (AIRTEL . 30 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_2.0gb_30days_322",
    "bundleSize": "2.0GB",
    "costPriceNgn": 1480,
    "markupNgn": 100,
    "amountNgn": 1580,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_2.0GB_30DAYS",
    "providerPlanCodes": {
      "smeapi": "322"
    },
    "planType": "Coupon",
    "validity": "30 Days",
    "description": "2.0GB Mobile Data (AIRTEL . 30 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_3.0gb_30days_323",
    "bundleSize": "3.0GB",
    "costPriceNgn": 1975,
    "markupNgn": 100,
    "amountNgn": 2075,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_3.0GB_30DAYS",
    "providerPlanCodes": {
      "smeapi": "323"
    },
    "planType": "Coupon",
    "validity": "30 Days",
    "description": "3.0GB Mobile Data (AIRTEL . 30 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_4.0gb_30days_324",
    "bundleSize": "4.0GB",
    "costPriceNgn": 2470,
    "markupNgn": 100,
    "amountNgn": 2570,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_4.0GB_30DAYS",
    "providerPlanCodes": {
      "smeapi": "324"
    },
    "planType": "Coupon",
    "validity": "30 Days",
    "description": "4.0GB Mobile Data (AIRTEL . 30 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_18.0gb_30days_328",
    "bundleSize": "18.0GB",
    "costPriceNgn": 5970,
    "markupNgn": 150,
    "amountNgn": 6120,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_18.0GB_30DAYS",
    "providerPlanCodes": {
      "smeapi": "328"
    },
    "planType": "Coupon",
    "validity": "30 Days",
    "description": "18.0GB Mobile Data (AIRTEL . 30 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_25.0gb_30days_329",
    "bundleSize": "25.0GB",
    "costPriceNgn": 7965,
    "markupNgn": 150,
    "amountNgn": 8115,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_25.0GB_30DAYS",
    "providerPlanCodes": {
      "smeapi": "329"
    },
    "planType": "Coupon",
    "validity": "30 Days",
    "description": "25.0GB Mobile Data (AIRTEL . 30 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_airtel_100.0gb_30days_332",
    "bundleSize": "100.0GB",
    "costPriceNgn": 20100,
    "markupNgn": 150,
    "amountNgn": 20250,
    "network": "airtel",
    "isActive": true,
    "planCode": "DATA_AIRTEL_100.0GB_30DAYS",
    "providerPlanCodes": {
      "smeapi": "332"
    },
    "planType": "Coupon",
    "validity": "30 Days",
    "description": "100.0GB Mobile Data (AIRTEL . 30 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_glo_200mb_14days_110",
    "bundleSize": "200MB",
    "costPriceNgn": 91,
    "markupNgn": 30,
    "amountNgn": 121,
    "network": "glo",
    "isActive": true,
    "planCode": "DATA_GLO_200MB_14DAYS",
    "providerPlanCodes": {
      "smeapi": "110"
    },
    "planType": "SME",
    "validity": "14 Days",
    "description": "200MB Mobile Data (GLO . 14 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_glo_500.0mb_30days_111",
    "bundleSize": "500.0MB",
    "costPriceNgn": 202,
    "markupNgn": 30,
    "amountNgn": 232,
    "network": "glo",
    "isActive": true,
    "planCode": "DATA_GLO_500.0MB_30DAYS",
    "providerPlanCodes": {
      "smeapi": "111"
    },
    "planType": "Corporate",
    "validity": "30 Days",
    "description": "500.0MB Mobile Data (GLO . 30 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_glo_750.0mb_1day_112",
    "bundleSize": "750.0MB",
    "costPriceNgn": 206,
    "markupNgn": 30,
    "amountNgn": 236,
    "network": "glo",
    "isActive": true,
    "planCode": "DATA_GLO_750.0MB_1DAY",
    "providerPlanCodes": {
      "smeapi": "112"
    },
    "planType": "Share",
    "validity": "1 Day",
    "description": "750.0MB Mobile Data (GLO . 1 Day)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_glo_1.0gb_3days_113",
    "bundleSize": "1.0GB",
    "costPriceNgn": 355,
    "markupNgn": 50,
    "amountNgn": 405,
    "network": "glo",
    "isActive": true,
    "planCode": "DATA_GLO_1.0GB_3DAYS",
    "providerPlanCodes": {
      "smeapi": "113"
    },
    "planType": "SME",
    "validity": "3 Days",
    "description": "1.0GB Mobile Data (GLO . 3 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_glo_1.0gb_7days_114",
    "bundleSize": "1.0GB",
    "costPriceNgn": 367,
    "markupNgn": 50,
    "amountNgn": 417,
    "network": "glo",
    "isActive": true,
    "planCode": "DATA_GLO_1.0GB_7DAYS",
    "providerPlanCodes": {
      "smeapi": "114"
    },
    "planType": "Gifting",
    "validity": "7 Days",
    "description": "1.0GB Mobile Data (GLO . 7 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_glo_1.0gb_1day_116",
    "bundleSize": "1.0GB",
    "costPriceNgn": 346,
    "markupNgn": 50,
    "amountNgn": 396,
    "network": "glo",
    "isActive": true,
    "planCode": "DATA_GLO_1.0GB_1DAY",
    "providerPlanCodes": {
      "smeapi": "116"
    },
    "planType": "SME",
    "validity": "1 Day",
    "description": "1.0GB Mobile Data (GLO . 1 Day)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_glo_1.0gb_30days_117",
    "bundleSize": "1.0GB",
    "costPriceNgn": 398,
    "markupNgn": 50,
    "amountNgn": 448,
    "network": "glo",
    "isActive": true,
    "planCode": "DATA_GLO_1.0GB_30DAYS",
    "providerPlanCodes": {
      "smeapi": "117"
    },
    "planType": "Corporate",
    "validity": "30 Days",
    "description": "1.0GB Mobile Data (GLO . 30 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_glo_1.5gb_1day_118",
    "bundleSize": "1.5GB",
    "costPriceNgn": 310,
    "markupNgn": 50,
    "amountNgn": 360,
    "network": "glo",
    "isActive": true,
    "planCode": "DATA_GLO_1.5GB_1DAY",
    "providerPlanCodes": {
      "smeapi": "118"
    },
    "planType": "Share",
    "validity": "1 Day",
    "description": "1.5GB Mobile Data (GLO . 1 Day)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_glo_2.0gb_1day_119",
    "bundleSize": "2.0GB",
    "costPriceNgn": 490,
    "markupNgn": 50,
    "amountNgn": 540,
    "network": "glo",
    "isActive": true,
    "planCode": "DATA_GLO_2.0GB_1DAY",
    "providerPlanCodes": {
      "smeapi": "119"
    },
    "planType": "SME",
    "validity": "1 Day",
    "description": "2.0GB Mobile Data (GLO . 1 Day)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_glo_2.0gb_30days_120",
    "bundleSize": "2.0GB",
    "costPriceNgn": 796,
    "markupNgn": 50,
    "amountNgn": 846,
    "network": "glo",
    "isActive": true,
    "planCode": "DATA_GLO_2.0GB_30DAYS",
    "providerPlanCodes": {
      "smeapi": "120"
    },
    "planType": "Corporate",
    "validity": "30 Days",
    "description": "2.0GB Mobile Data (GLO . 30 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_glo_2.5gb_2days_121",
    "bundleSize": "2.5GB",
    "costPriceNgn": 500,
    "markupNgn": 50,
    "amountNgn": 550,
    "network": "glo",
    "isActive": true,
    "planCode": "DATA_GLO_2.5GB_2DAYS",
    "providerPlanCodes": {
      "smeapi": "121"
    },
    "planType": "Share",
    "validity": "2 Days",
    "description": "2.5GB Mobile Data (GLO . 2 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_glo_3.0gb_3days_122",
    "bundleSize": "3.0GB",
    "costPriceNgn": 895,
    "markupNgn": 50,
    "amountNgn": 945,
    "network": "glo",
    "isActive": true,
    "planCode": "DATA_GLO_3.0GB_3DAYS",
    "providerPlanCodes": {
      "smeapi": "122"
    },
    "planType": "SME",
    "validity": "3 Days",
    "description": "3.0GB Mobile Data (GLO . 3 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_glo_3.0gb_7days_123",
    "bundleSize": "3.0GB",
    "costPriceNgn": 975,
    "markupNgn": 50,
    "amountNgn": 1025,
    "network": "glo",
    "isActive": true,
    "planCode": "DATA_GLO_3.0GB_7DAYS",
    "providerPlanCodes": {
      "smeapi": "123"
    },
    "planType": "Gifting",
    "validity": "7 Days",
    "description": "3.0GB Mobile Data (GLO . 7 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_glo_3.0gb_30days_125",
    "bundleSize": "3.0GB",
    "costPriceNgn": 1194,
    "markupNgn": 100,
    "amountNgn": 1294,
    "network": "glo",
    "isActive": true,
    "planCode": "DATA_GLO_3.0GB_30DAYS",
    "providerPlanCodes": {
      "smeapi": "125"
    },
    "planType": "Corporate",
    "validity": "30 Days",
    "description": "3.0GB Mobile Data (GLO . 30 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_glo_5.0gb_3days_126",
    "bundleSize": "5.0GB",
    "costPriceNgn": 1375,
    "markupNgn": 100,
    "amountNgn": 1475,
    "network": "glo",
    "isActive": true,
    "planCode": "DATA_GLO_5.0GB_3DAYS",
    "providerPlanCodes": {
      "smeapi": "126"
    },
    "planType": "SME",
    "validity": "3 Days",
    "description": "5.0GB Mobile Data (GLO . 3 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_glo_5.0gb_7days_127",
    "bundleSize": "5.0GB",
    "costPriceNgn": 1625,
    "markupNgn": 100,
    "amountNgn": 1725,
    "network": "glo",
    "isActive": true,
    "planCode": "DATA_GLO_5.0GB_7DAYS",
    "providerPlanCodes": {
      "smeapi": "127"
    },
    "planType": "Gifting",
    "validity": "7 Days",
    "description": "5.0GB Mobile Data (GLO . 7 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_glo_5.0gb_14days_128",
    "bundleSize": "5.0GB",
    "costPriceNgn": 1675,
    "markupNgn": 100,
    "amountNgn": 1775,
    "network": "glo",
    "isActive": true,
    "planCode": "DATA_GLO_5.0GB_14DAYS",
    "providerPlanCodes": {
      "smeapi": "128"
    },
    "planType": "Gifting",
    "validity": "14 Days",
    "description": "5.0GB Mobile Data (GLO . 14 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_glo_5.0gb_30days_129",
    "bundleSize": "5.0GB",
    "costPriceNgn": 1990,
    "markupNgn": 100,
    "amountNgn": 2090,
    "network": "glo",
    "isActive": true,
    "planCode": "DATA_GLO_5.0GB_30DAYS",
    "providerPlanCodes": {
      "smeapi": "129"
    },
    "planType": "Corporate",
    "validity": "30 Days",
    "description": "5.0GB Mobile Data (GLO . 30 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_glo_10.0gb_7days_130",
    "bundleSize": "10.0GB",
    "costPriceNgn": 1950,
    "markupNgn": 100,
    "amountNgn": 2050,
    "network": "glo",
    "isActive": true,
    "planCode": "DATA_GLO_10.0GB_7DAYS",
    "providerPlanCodes": {
      "smeapi": "130"
    },
    "planType": "Share",
    "validity": "7 Days",
    "description": "10.0GB Mobile Data (GLO . 7 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_glo_10.0gb_14days_132",
    "bundleSize": "10.0GB",
    "costPriceNgn": 3350,
    "markupNgn": 150,
    "amountNgn": 3500,
    "network": "glo",
    "isActive": true,
    "planCode": "DATA_GLO_10.0GB_14DAYS",
    "providerPlanCodes": {
      "smeapi": "132"
    },
    "planType": "Gifting",
    "validity": "14 Days",
    "description": "10.0GB Mobile Data (GLO . 14 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_glo_10.0gb_30days_133",
    "bundleSize": "10.0GB",
    "costPriceNgn": 3980,
    "markupNgn": 150,
    "amountNgn": 4130,
    "network": "glo",
    "isActive": true,
    "planCode": "DATA_GLO_10.0GB_30DAYS",
    "providerPlanCodes": {
      "smeapi": "133"
    },
    "planType": "Corporate",
    "validity": "30 Days",
    "description": "10.0GB Mobile Data (GLO . 30 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_glo_12.0gb_30days_134",
    "bundleSize": "12.0GB",
    "costPriceNgn": 3795,
    "markupNgn": 150,
    "amountNgn": 3945,
    "network": "glo",
    "isActive": true,
    "planCode": "DATA_GLO_12.0GB_30DAYS",
    "providerPlanCodes": {
      "smeapi": "134"
    },
    "planType": "Corporate",
    "validity": "30 Days",
    "description": "12.0GB Mobile Data (GLO . 30 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_glo_16.0gb_30days_135",
    "bundleSize": "16.0GB",
    "costPriceNgn": 4745,
    "markupNgn": 150,
    "amountNgn": 4895,
    "network": "glo",
    "isActive": true,
    "planCode": "DATA_GLO_16.0GB_30DAYS",
    "providerPlanCodes": {
      "smeapi": "135"
    },
    "planType": "Corporate",
    "validity": "30 Days",
    "description": "16.0GB Mobile Data (GLO . 30 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_glo_20.0gb_30days_136",
    "bundleSize": "20.0GB",
    "costPriceNgn": 5680,
    "markupNgn": 150,
    "amountNgn": 5830,
    "network": "glo",
    "isActive": true,
    "planCode": "DATA_GLO_20.0GB_30DAYS",
    "providerPlanCodes": {
      "smeapi": "136"
    },
    "planType": "Corporate",
    "validity": "30 Days",
    "description": "20.0GB Mobile Data (GLO . 30 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_glo_10gb_30days_333",
    "bundleSize": "10GB",
    "costPriceNgn": 2935,
    "markupNgn": 100,
    "amountNgn": 3035,
    "network": "glo",
    "isActive": true,
    "planCode": "DATA_GLO_10GB_30DAYS",
    "providerPlanCodes": {
      "smeapi": "333"
    },
    "planType": "Corporate",
    "validity": "30 Days",
    "description": "10GB Mobile Data (GLO . 30 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_smeapi_sync"
  },
  {
    "id": "plan_9mobile_500mb_1day",
    "bundleSize": "500MB",
    "costPriceNgn": 200,
    "markupNgn": 50,
    "amountNgn": 250,
    "network": "9mobile",
    "isActive": true,
    "planCode": "DATA_9MOBILE_500MB_1DAY",
    "providerPlanCodes": {
      "paystack": "9mobile_500mb_1d"
    },
    "planType": "Direct",
    "validity": "1 Day",
    "description": "500MB Mobile Data (9MOBILE . 1 Day)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_paystack_sync"
  },
  {
    "id": "plan_9mobile_1gb_1day",
    "bundleSize": "1GB",
    "costPriceNgn": 350,
    "markupNgn": 50,
    "amountNgn": 400,
    "network": "9mobile",
    "isActive": true,
    "planCode": "DATA_9MOBILE_1GB_1DAY",
    "providerPlanCodes": {
      "paystack": "9mobile_1gb_1d"
    },
    "planType": "Direct",
    "validity": "1 Day",
    "description": "1GB Mobile Data (9MOBILE . 1 Day)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_paystack_sync"
  },
  {
    "id": "plan_9mobile_2gb_2days",
    "bundleSize": "2GB",
    "costPriceNgn": 500,
    "markupNgn": 100,
    "amountNgn": 600,
    "network": "9mobile",
    "isActive": true,
    "planCode": "DATA_9MOBILE_2GB_2DAYS",
    "providerPlanCodes": {
      "paystack": "9mobile_2gb_2d"
    },
    "planType": "Direct",
    "validity": "2 Days",
    "description": "2GB Mobile Data (9MOBILE . 2 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_paystack_sync"
  },
  {
    "id": "plan_9mobile_1gb_7days",
    "bundleSize": "1GB",
    "costPriceNgn": 400,
    "markupNgn": 50,
    "amountNgn": 450,
    "network": "9mobile",
    "isActive": true,
    "planCode": "DATA_9MOBILE_1GB_7DAYS",
    "providerPlanCodes": {
      "paystack": "9mobile_1gb_7d"
    },
    "planType": "Direct",
    "validity": "7 Days",
    "description": "1GB Mobile Data (9MOBILE . 7 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_paystack_sync"
  },
  {
    "id": "plan_9mobile_2gb_7days",
    "bundleSize": "2GB",
    "costPriceNgn": 700,
    "markupNgn": 100,
    "amountNgn": 800,
    "network": "9mobile",
    "isActive": true,
    "planCode": "DATA_9MOBILE_2GB_7DAYS",
    "providerPlanCodes": {
      "paystack": "9mobile_2gb_7d"
    },
    "planType": "Direct",
    "validity": "7 Days",
    "description": "2GB Mobile Data (9MOBILE . 7 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_paystack_sync"
  },
  {
    "id": "plan_9mobile_1gb_30days",
    "bundleSize": "1GB",
    "costPriceNgn": 450,
    "markupNgn": 50,
    "amountNgn": 500,
    "network": "9mobile",
    "isActive": true,
    "planCode": "DATA_9MOBILE_1GB_30DAYS",
    "providerPlanCodes": {
      "paystack": "9mobile_1gb_30d"
    },
    "planType": "Direct",
    "validity": "30 Days",
    "description": "1GB Mobile Data (9MOBILE . 30 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_paystack_sync"
  },
  {
    "id": "plan_9mobile_2gb_30days",
    "bundleSize": "2GB",
    "costPriceNgn": 800,
    "markupNgn": 100,
    "amountNgn": 900,
    "network": "9mobile",
    "isActive": true,
    "planCode": "DATA_9MOBILE_2GB_30DAYS",
    "providerPlanCodes": {
      "paystack": "9mobile_2gb_30d"
    },
    "planType": "Direct",
    "validity": "30 Days",
    "description": "2GB Mobile Data (9MOBILE . 30 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_paystack_sync"
  },
  {
    "id": "plan_9mobile_4.5gb_30days",
    "bundleSize": "4.5GB",
    "costPriceNgn": 1800,
    "markupNgn": 200,
    "amountNgn": 2000,
    "network": "9mobile",
    "isActive": true,
    "planCode": "DATA_9MOBILE_4.5GB_30DAYS",
    "providerPlanCodes": {
      "paystack": "9mobile_4.5gb_30d"
    },
    "planType": "Direct",
    "validity": "30 Days",
    "description": "4.5GB Mobile Data (9MOBILE . 30 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_paystack_sync"
  },
  {
    "id": "plan_9mobile_11gb_30days",
    "bundleSize": "11GB",
    "costPriceNgn": 3600,
    "markupNgn": 400,
    "amountNgn": 4000,
    "network": "9mobile",
    "isActive": true,
    "planCode": "DATA_9MOBILE_11GB_30DAYS",
    "providerPlanCodes": {
      "paystack": "9mobile_11gb_30d"
    },
    "planType": "Direct",
    "validity": "30 Days",
    "description": "11GB Mobile Data (9MOBILE . 30 Days)",
    "updatedAt": "2026-11-19T00:00:00.000Z",
    "updatedBy": "system_paystack_sync"
  }
];
