import crypto from 'node:crypto';
import pg from 'pg';
import Decimal from 'decimal.js';

const { Pool } = pg;

export const config = {
  api: { bodyParser: false },
};

let pool;

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: requiredEnv('DATABASE_URL'),
      max: 3,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 10000,
    });
  }
  return pool;
}

async function readRawBody(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;

    if (size > 1024 * 1024) {
      const error = new Error('Request body too large');
      error.status = 413;
      throw error;
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

function verifySignature(rawBody, signature, secret) {
  if (
    typeof signature !== 'string' ||
    !/^[A-Za-z0-9+/]{43}=$/.test(signature)
  ) {
    return false;
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest();

  const received = Buffer.from(signature, 'base64');

  return (
    received.length === expected.length &&
    crypto.timingSafeEqual(expected, received)
  );
}

function stringId(value) {
  if (typeof value === 'string' && /^\d+$/.test(value)) return value;

  if (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0
  ) {
    return String(value);
  }

  throw new Error('Missing or invalid numeric ID');
}

function positiveAmount(value) {
  if (
    !['number', 'string'].includes(typeof value) ||
    String(value).trim() === ''
  ) {
    throw new Error('Invalid payment amount');
  }

  const amount = new Decimal(value);

  if (!amount.isFinite() || !amount.gt(0)) {
    throw new Error('Invalid payment amount');
  }

  return amount;
}

function callbackUrl() {
  const url = new URL(requiredEnv('NOWPAYMENTS_IPN_CALLBACK_URL'));

  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error('Invalid IPN callback URL');
  }

  return url.toString();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('Method Not Allowed');
  }

  let orderId;
  let creationReserved = false;
  let saved = false;

  try {
    const secret = requiredEnv('SHOPIFY_WEBHOOK_SECRET');
    const rawBody = await readRawBody(req);

    if (
      !verifySignature(
        rawBody,
        req.headers['x-shopify-hmac-sha256'],
        secret
      )
    ) {
      return res.status(403).send('Invalid signature');
    }

    const expectedShop = requiredEnv('SHOPIFY_SHOP')
      .trim()
      .toLowerCase();

    if (
      !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(expectedShop)
    ) {
      throw new Error('Invalid SHOPIFY_SHOP');
    }

    if (
      req.headers['x-shopify-shop-domain'] !== expectedShop ||
      req.headers['x-shopify-topic'] !== 'orders/create'
    ) {
      return res.status(400).send('Unexpected shop or webhook topic');
    }

    let order;
    try {
      order = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return res.status(400).send('Invalid JSON');
    }

    if (!order || typeof order !== 'object' || Array.isArray(order)) {
      return res.status(400).send('Invalid order payload');
    }

    // 必须与 Shopify 订单中的付款方式名称完全一致。
    const paymentMethod = requiredEnv('NOWPAYMENTS_PAYMENT_METHOD');

    const eligible =
      Array.isArray(order.payment_gateway_names) &&
      order.payment_gateway_names.includes(paymentMethod);

    if (!eligible || order.cancelled_at || order.financial_status !== 'pending') {
      return res.status(200).json({
        received: true,
        skipped: true,
      });
    }

    orderId = stringId(order.id);
    const price = positiveAmount(
      order.current_total_price ?? order.total_price
    );

    const priceCurrency =
      typeof order.currency === 'string'
        ? order.currency.toLowerCase()
        : '';

    if (!/^[a-z]{3}$/.test(priceCurrency)) {
      throw new Error('Invalid order currency');
    }

    const payCurrency = requiredEnv('NOWPAYMENTS_PAY_CURRENCY')
      .trim()
      .toLowerCase();

    const apiKey = requiredEnv('NOWPAYMENTS_API_KEY');
    const ipnUrl = callbackUrl();

    // NOWPayments 接口要求金额为 JSON number。
    // 转换时若损失金额精度则停止，不静默舍入。
    const numericPrice = price.toNumber();

    if (!new Decimal(numericPrice).eq(price)) {
      throw new Error('Price cannot be represented safely');
    }

    const db = getPool();

    // 原子占位：两个并发通知只有一个能创建付款。
    // 在调用 NOWPayments 前先持久化，不能只用内存去重。
    const reservation = await db.query(
      `INSERT INTO nowpayments_order_jobs
         (shopify_order_id, state)
       VALUES ($1, 'creating')
       ON CONFLICT (shopify_order_id) DO NOTHING
       RETURNING shopify_order_id`,
      [orderId]
    );

    if (!reservation.rows.length) {
      const existing = await db.query(
        `SELECT state
         FROM nowpayments_order_jobs
         WHERE shopify_order_id = $1`,
        [orderId]
      );

      if (existing.rows[0]?.state === 'created') {
        return res.status(200).json({
          received: true,
          duplicate: true,
        });
      }

      // creating 或 review 状态不自动再次创建付款。
      return res.status(503).send(
        'Payment creation pending or requires manual review'
      );
    }

    creationReserved = true;

    const response = await fetch(
      'https://api.nowpayments.io/v1/payment',
      {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({
          price_amount: numericPrice,
          price_currency: priceCurrency,
          pay_currency: payCurrency,
          order_id: orderId,
          order_description: `Shopify order ${order.name || orderId}`,
          ipn_callback_url: ipnUrl,
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`NOWPayments HTTP ${response.status}`);
    }

    const payment = await response.json();
    const paymentId = stringId(payment.payment_id);
    const payAmount = positiveAmount(payment.pay_amount);
    const returnedPrice = positiveAmount(payment.price_amount);

    if (
      String(payment.order_id) !== orderId ||
      !returnedPrice.eq(price) ||
      String(payment.price_currency).toLowerCase() !== priceCurrency ||
      String(payment.pay_currency).toLowerCase() !== payCurrency ||
      typeof payment.pay_address !== 'string' ||
      !payment.pay_address
    ) {
      throw new Error('Unexpected NOWPayments payment response');
    }

    const client = await db.connect();

    try {
      await client.query('BEGIN');

      await client.query(
        `INSERT INTO nowpayments_payments (
           payment_id,
           shopify_order_id,
           merchant_order_id,
           price_amount,
           price_currency,
           pay_amount,
           pay_currency
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          paymentId,
          orderId,
          orderId,
          price.toFixed(),
          priceCurrency,
          payAmount.toFixed(),
          payCurrency,
        ]
      );

      await client.query(
        `UPDATE nowpayments_order_jobs
         SET state = 'created',
             payment_id = $2,
             review_reason = NULL,
             updated_at = NOW()
         WHERE shopify_order_id = $1`,
        [orderId, paymentId]
      );

      await client.query('COMMIT');
      saved = true;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // 保留主错误。
      }
      throw error;
    } finally {
      client.release();
    }

    // 此处尚未向客户发送付款信息。
    // 不在日志里输出客户信息、API key 或完整付款响应。
    console.log('NOWPayments payment mapping saved:', orderId, paymentId);

    return res.status(200).json({
      received: true,
      paymentCreated: true,
    });
  } catch (error) {
    if (creationReserved && !saved && orderId) {
      try {
        await getPool().query(
          `UPDATE nowpayments_order_jobs
           SET state = 'review',
               review_reason = $2,
               updated_at = NOW()
           WHERE shopify_order_id = $1
             AND state = 'creating'`,
          [
            orderId,
            'Creation result uncertain or mapping save failed; ' +
              'check NOWPayments before retrying',
          ]
        );
      } catch {
        console.error('Could not save payment creation review state');
      }
    }

    console.error('Order webhook processing failed:', error.message);

    return res
      .status(error.status === 413 ? 413 : 503)
      .send(
        error.status === 413
          ? 'Request body too large'
          : 'Processing failed; review or retry required'
      );
  }
}
