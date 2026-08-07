import type { FastifyInstance } from 'fastify';
import { parseBody } from '../shared/validation.js';
import { createSupplier, createSupplierPayment, createSupplierPaymentSchema, createSupplierSchema, getSupplierPayment, getSupplierPaymentControls, listAdminSupplierPayments, listAdminSuppliers, listUserSupplierPayments, listUserSuppliers, reviewSupplier, releaseSupplierPaymentSchema, releaseSupplierPaymentToProvider, reviewSupplierPayment, reviewSupplierPaymentSchema, reviewSupplierSchema, syncSupplierPaymentProviderStatus, updateSupplierPaymentControls, quoteSupplierPayment } from './supplier.service.js';
import { supplierControlsSchema } from '../risk/supplier-risk.service.js';
import { badRequest } from '../shared/errors.js';

export async function supplierRoutes(app: FastifyInstance) {
  app.get('/api/users/:userId/suppliers', async (request) => {
    const { userId } = request.params as { userId: string };
    return { data: await listUserSuppliers(userId) };
  });

  app.post('/api/users/:userId/suppliers', async (request) => {
    const { userId } = request.params as { userId: string };
    const body = parseBody(createSupplierSchema, { ...(request.body as any), userId });
    return { data: await createSupplier(body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  app.get('/api/users/:userId/supplier-payments', async (request) => {
    const { userId } = request.params as { userId: string };
    return { data: await listUserSupplierPayments(userId) };
  });

  /**
   * What a supplier payment would cost, without creating one.
   *
   * The confirm dialog calls this rather than doing the arithmetic itself.
   * Two copies of a pricing rule is how they come to disagree, and a UI that
   * quotes a different fee from the one charged reads as theft.
   */
  app.get('/api/users/:userId/supplier-payments/quote', async (request) => {
    const { userId } = request.params as { userId: string };
    const { amount } = request.query as { amount?: string };
    const parsed = Number(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) throw badRequest('A positive amount is required to quote a supplier payment.');
    return { data: await quoteSupplierPayment(userId, parsed) };
  });

  app.post('/api/users/:userId/supplier-payments', async (request) => {
    const { userId } = request.params as { userId: string };
    const body = parseBody(createSupplierPaymentSchema, { ...(request.body as any), userId });
    return { data: await createSupplierPayment(body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  app.get('/api/admin/supplier-payments/controls', async () => ({ data: await getSupplierPaymentControls() }));

  app.put('/api/admin/supplier-payments/controls', async (request) => {
    const body = parseBody(supplierControlsSchema, request.body);
    return { data: await updateSupplierPaymentControls(body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  app.get('/api/admin/suppliers', async () => ({ data: await listAdminSuppliers() }));
  app.get('/api/admin/supplier-payments', async () => ({ data: await listAdminSupplierPayments() }));
  app.get('/api/admin/supplier-payments/:id', async (request) => {
    const { id } = request.params as { id: string };
    return { data: await getSupplierPayment(id) };
  });

  app.post('/api/admin/suppliers/:id/review', async (request) => {
    const { id } = request.params as { id: string };
    const actor = (request as any).adminActor?.email || (request as any).adminActor?.role || 'admin_api_key';
    const body = parseBody(reviewSupplierSchema, { ...(request.body as any), reviewedBy: (request.body as any)?.reviewedBy || actor });
    return { data: await reviewSupplier(id, body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  app.post('/api/admin/supplier-payments/:id/review', async (request) => {
    const { id } = request.params as { id: string };
    const actor = (request as any).adminActor?.email || (request as any).adminActor?.role || 'admin_api_key';
    const body = parseBody(reviewSupplierPaymentSchema, { ...(request.body as any), reviewedBy: (request.body as any)?.reviewedBy || actor });
    return { data: await reviewSupplierPayment(id, body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });


  app.post('/api/admin/supplier-payments/:id/release', async (request) => {
    const { id } = request.params as { id: string };
    const actor = (request as any).adminActor?.email || (request as any).adminActor?.role || 'admin_api_key';
    const body = parseBody(releaseSupplierPaymentSchema, { ...(request.body as any), releasedBy: (request.body as any)?.releasedBy || actor });
    return { data: await releaseSupplierPaymentToProvider(id, body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  app.post('/api/admin/supplier-payments/:id/sync', async (request) => {
    const { id } = request.params as { id: string };
    return { data: await syncSupplierPaymentProviderStatus(id) };
  });
}
