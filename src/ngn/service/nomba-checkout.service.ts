/**
 * NOMBA HOSTED CHECKOUT SERVICE
 *
 * Implements Nomba Checkout operations while delegating to the unified
 * Sivan checkout layer and NombaCheckoutProvider.
 */

import { NombaCheckoutProvider } from '../provider/nomba-checkout.provider.js';
import { sivanCheckoutService } from './sivan-checkout.service.js';
import type {
  CreateCheckoutInput,
  CheckoutOrderResult,
  CheckoutVerificationResult,
} from '../provider/checkout-provider.interface.js';

export type CreateNombaCheckoutInput = CreateCheckoutInput;
export type NombaCheckoutOrderResult = CheckoutOrderResult;
export type NombaCheckoutVerificationResult = CheckoutVerificationResult;
export type NombaCheckoutProcessingResult = any;

export class NombaCheckoutService {
  private provider = new NombaCheckoutProvider();

  public async createCheckoutOrder(input: CreateCheckoutInput): Promise<CheckoutOrderResult> {
    return this.provider.createCheckoutOrder(input);
  }

  public async verifyCheckoutTransaction(orderReference: string): Promise<CheckoutVerificationResult> {
    return this.provider.verifyCheckoutOrder(orderReference);
  }

  public async processCheckoutSuccess(verification: CheckoutVerificationResult): Promise<any> {
    return sivanCheckoutService.processCheckoutSuccess(verification);
  }
}

export const nombaCheckoutService = new NombaCheckoutService();
