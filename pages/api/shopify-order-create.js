// Replace pages/api/shopify-order-create.js with this file.
import crypto from 'node:crypto';
import { createInvoiceAndEmail } from '../../lib/nowpayments-invoices';
export const config = { api: { bodyParser: false } };
function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}
async function rawBody(req) {
  const buffers = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1024 * 1024) {
      const error = new Error('Request too large');
      error.status = 413;
      throw error;
    }
    buffers.push(buffer);
  }
  return Buffer.concat(buffers);
}
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('Method Not Allowed');
  }
  try {
    const secret = env('SHOPIFY_WEBHOOK_SECRET');
    const body = await rawBody(req);
    const signature = req.headers['x-shopify-hmac-sha256'];
    if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(signature)) return res.status(403).send('Invalid signature');
    const expected = crypto.createHmac('sha256', secret).update(body).digest();
    const received = Buffer.from(signature, 'base64');
    if (received.length !== expected.length || !crypto.timingSafeEqual(expected, received)) return res.status(403).send('Invalid signature');
    const shop = env('SHOPIFY_SHOP').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) throw new Error('Invalid SHOPIFY_SHOP');
    if (req.headers['x-shopify-shop-domain'] !== shop || req.headers['x-shopify-topic'] !== 'orders/create') return res.status(400).send('Unexpected shop or topic');
    let order;
    try { order = JSON.parse(body.toString('utf8')); } catch { return res.status(400).send('Invalid JSON'); }
    if (!order || typeof order !== 'object' || Array.isArray(order)) return res.status(400).send('Invalid order');
    const method = env('NOWPAYMENTS_PAYMENT_METHOD');
    const eligible = Array.isArray(order.payment_gateway_names) && order.payment_gateway_names.includes(method);
    if (!eligible || order.cancelled_at || order.financial_status !== 'pending') return res.status(200).json({ received: true, skipped: true });
    // Explicit deployment switch. Enable only after domain verification, tables, and testing.
    if (process.env.PAYMENT_EMAILS_ENABLED !== 'true') return res.status(503).send('Payment email workflow not enabled');
    const outcome = await createInvoiceAndEmail(order);
    console.log('Invoice email request accepted for order:', String(order.id));
    return res.status(200).json({ received: true, ...outcome });
  } catch (error) {
    console.error('Invoice workflow failed:', error.message);
    return res.status(error.status === 413 ? 413 : 503).send('Processing failed; retry or manual review required');
  }
}
