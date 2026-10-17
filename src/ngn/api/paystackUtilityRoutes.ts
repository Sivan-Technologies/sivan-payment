/**
 * SIVAN PAYSTACK UTILITY ROUTES
 *
 * Fastify endpoints for:
 * - Airtime topup
 * - Mobile data bundles
 * - Electricity meter inquiry (pre-flight customer lookup)
 * - Electricity bill payment & token issuance
 * - User NGN spendable balance lookup
 */

import { z } from 'zod';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { parseBody } from '../../shared/validation.js';
import { badRequest } from '../../shared/errors.js';
import {
  executeAirtimePurchase,
  executeDataPurchase,
  executeElectricityInquiry,
  executeElectricityPayment,
  getUserNgnBalance,
} from '../service/sivanUtilityService.js';
import type { TelcoOperator, DiscoCode, MeterType } from '../types/paystackUtilityTypes.js';

const airtimeSchema = z.object({
  userId: z.string().min(1, 'userId is required'),
  phone: z.string().min(10, 'phone is required'),
  amountNgn: z.number().int().min(100, 'Minimum airtime is 100 NGN').max(50000, 'Maximum airtime is 50,000 NGN'),
  operator: z.enum(['mtn', 'airtel', 'glo', '9mobile']).optional(),
  providerName: z.string().optional(),
});

const dataSchema = z.object({
  userId: z.string().min(1, 'userId is required'),
  phone: z.string().min(10, 'phone is required'),
  planCode: z.string().min(1, 'planCode is required'),
  amountNgn: z.number().int().min(100, 'Minimum amount is 100 NGN'),
  operator: z.enum(['mtn', 'airtel', 'glo', '9mobile']).optional(),
  providerName: z.string().optional(),
});

const electricityInquirySchema = z.object({
  userId: z.string().min(1, 'userId is required'),
  meterNumber: z.string().min(6, 'Valid meter number is required'),
  disco: z.enum([
    'ikeja',
    'eko',
    'abuja',
    'ibadan',
    'enugu',
    'kano',
    'port-harcourt',
    'benin',
    'jos',
    'kaduna',
    'yola',
  ]),
  meterType: z.enum(['prepaid', 'postpaid']).default('prepaid'),
  providerName: z.string().optional(),
});

const electricityPaymentSchema = z.object({
  userId: z.string().min(1, 'userId is required'),
  meterNumber: z.string().min(6, 'Valid meter number is required'),
  disco: z.enum([
    'ikeja',
    'eko',
    'abuja',
    'ibadan',
    'enugu',
    'kano',
    'port-harcourt',
    'benin',
    'jos',
    'kaduna',
    'yola',
  ]),
  meterType: z.enum(['prepaid', 'postpaid']).default('prepaid'),
  amountNgn: z.number().int().min(1000, 'Minimum electricity recharge is 1,000 NGN'),
  customerName: z.string().optional(),
  providerName: z.string().optional(),
});

export async function paystackUtilityRoutes(app: FastifyInstance) {
  /**
   * GET /api/ngn/utility/balance/:userId
   * Spendable NGN balance check for a user.
   */
  app.get(
    '/api/ngn/utility/balance/:userId',
    async (request: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
      const { userId } = request.params;
      if (!userId || !userId.trim()) {
        throw badRequest('userId is required');
      }

      const balance = await getUserNgnBalance(userId);
      return reply.code(200).send({
        status: 'success',
        data: {
          userId,
          currency: 'NGN',
          spendableBalanceNgn: balance,
        },
      });
    }
  );

  /**
   * POST /api/ngn/utility/airtime
   * Purchases telco airtime and atomically debits user balance.
   */
  app.post('/api/ngn/utility/airtime', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = parseBody(airtimeSchema, request.body);
    const receipt = await executeAirtimePurchase({
      userId: body.userId,
      phone: body.phone,
      amountNgn: body.amountNgn,
      operator: body.operator as TelcoOperator | undefined,
      providerName: body.providerName,
    });

    return reply.code(200).send({
      status: 'success',
      data: receipt,
    });
  });

  /**
   * POST /api/ngn/utility/data
   * Purchases telco data bundle and atomically debits user balance.
   */
  app.post('/api/ngn/utility/data', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = parseBody(dataSchema, request.body);
    const receipt = await executeDataPurchase({
      userId: body.userId,
      phone: body.phone,
      planCode: body.planCode,
      amountNgn: body.amountNgn,
      operator: body.operator as TelcoOperator | undefined,
      providerName: body.providerName,
    });

    return reply.code(200).send({
      status: 'success',
      data: receipt,
    });
  });

  /**
   * POST /api/ngn/utility/electricity/inquire
   * Pre-flight inquiry: retrieves registered customer name for the meter.
   */
  app.post('/api/ngn/utility/electricity/inquire', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = parseBody(electricityInquirySchema, request.body);
    const inquiry = await executeElectricityInquiry({
      userId: body.userId,
      meterNumber: body.meterNumber,
      disco: body.disco as DiscoCode,
      meterType: body.meterType as MeterType,
      providerName: body.providerName,
    });

    return reply.code(200).send({
      status: 'success',
      data: inquiry,
    });
  });

  /**
   * POST /api/ngn/utility/electricity/pay
   * Purchases electricity and issues a 20-digit token for prepaid meters.
   */
  app.post('/api/ngn/utility/electricity/pay', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = parseBody(electricityPaymentSchema, request.body);
    const receipt = await executeElectricityPayment({
      userId: body.userId,
      meterNumber: body.meterNumber,
      disco: body.disco as DiscoCode,
      meterType: body.meterType as MeterType,
      amountNgn: body.amountNgn,
      customerName: body.customerName,
      providerName: body.providerName,
    });

    return reply.code(200).send({
      status: 'success',
      data: receipt,
    });
  });
}
