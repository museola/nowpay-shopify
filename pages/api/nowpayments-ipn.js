import crypto from 'node:crypto';
import pg from 'pg';
import Decimal from 'decimal.js';

const { Pool } = pg;

export const config = {
  api: { bodyParser: false },
};

let pool;
let tokenCache = null;
let tokenRequest = null;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

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

function getShop() {
  const shop = requiredEnv('SHOPIFY_SHOP').trim().toLowerCase();

  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
    throw new Error('SHOPIFY_SHOP must be a myshopify.com hostname');
  }

  return shop;
}

// 与 NOWPayments 官方 Node.js 示例使用相同的递归排序方式。
// 不删除任何已签名字段。
function sortObject(value) {
  if (value === null || typeof value !== 'object') return value;

  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      Object.defineProperty(result, key, {
        value: sortObject(value[key]),
        enumerable: true,
        configurable: true,
        writable: true,
      });
      return result;
    }, {});
}

async function readRawBody(req) {
  const chunks = [];
  let size = 0;
  const limit = 1024 * 1024;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;

    if (size > limit) {
      throw new HttpError(413, 'Request body too large');
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

function verifySignature(data, header, secret) {
  if (
    typeof header !== 'string' ||
    !/^[a-f0-9]{128}$/i.test(header)
  ) {
    return false;
  }

  const expected = crypto
    .createHmac('sha512', secret)
    .update(JSON.stringify(sortObject(data)), 'utf8')
    .digest();

  const received = Buffer.from(header, 'hex');

  return (
    received.length === expected.length &&
    crypto.timingSafeEqual(received, expected)
  );
}

function identifier(value) {
  if (typeof value === 'string' && value.length > 0) return value;

  // 避免把已丢失精度的大整数当成正确 ID。
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return String(value);
  }

  throw new HttpError(400, 'Invalid identifier');
}

function currency(value) {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function positiveDecimal(value) {
  if (
    !['string', 'number'].includes(typeof value) ||
    String(value).trim() === ''
  ) {
    throw new Error('Invalid amount');
  }

  const amount = new Decimal(value);

  if (!amount.isFinite() || !amount.gt(0)) {
    throw new Error('Invalid amount');
  }

  return amount;
}

async function fetchJson(url, options = {}, label = 'API') {
  const response = await fetch(url, {
    ...options,
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });

  // 不把 API 原始响应写入日志，避免泄露敏感数据。
  if (!response.ok) {
    throw new Error(`${label} HTTP ${response.status}`);
  }

  try {
    return await response.json();
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

async function getShopifyAccessToken(shop) {
  const now = Date.now();

  if (
    tokenCache?.shop === shop &&
    tokenCache.expiresAt > now + 60000
  ) {
    return tokenCache.token;
  }

  if (tokenRequest) return tokenRequest;

  tokenRequest = (async () => {
    const startedAt = Date.now();

    const data = await fetchJson(
      `https://${shop}/admin/oauth/access_token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'client_credentials',
          client_id: requiredEnv('SHOPIFY_CLIENT_ID'),
          client_secret: requiredEnv('SHOPIFY_CLIENT_SECRET'),
        }),
      },
      'Shopify token'
    );

    const expiresIn = Number(data.expires_in);

    if (
      typeof data.access_token !== 'string' ||
      !data.access_token ||
      !Number.isFinite(expiresIn) ||
      expiresIn <= 60
    ) {
      throw new Error('Invalid Shopify token response');
    }

    tokenCache = {
      shop,
      token: data.access_token,
      expiresAt: startedAt + expiresIn * 1000,
    };

    return data.access_token;
  })();

  try {
    return await tokenRequest;
  } finally {
    tokenRequest = null;
  }
}

async function shopifyRequest(shop, token, path, method = 'GET', body) {
  return fetchJson(
    `https://${shop}/admin/api/2026-10${path}`,
    {
      method,
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    'Shopify'
  );
}

function paymentMismatch(data, mapping) {
  if (
    data.parent_payment_id !== null &&
    data.parent_payment_id !== undefined &&
    String(data.parent_payment_id) !== ''
  ) {
    return 'Repeated or related deposit requires manual review';
  }

  if (String(data.order_id) !== mapping.merchant_order_id) {
    return 'Merchant order ID mismatch';
  }

  if (
    currency(data.price_currency) !== currency(mapping.price_currency) ||
    currency(data.pay_currency) !== currency(mapping.pay_currency)
  ) {
    return 'Currency mismatch';
  }

  try {
    if (
      !positiveDecimal(data.price_amount).eq(mapping.price_amount) ||
      !positiveDecimal(data.pay_amount).eq(mapping.pay_amount)
    ) {
      return 'Expected amount mismatch';
    }

    if (positiveDecimal(data.actually_paid).lt(mapping.pay_amount)) {
      return 'Insufficient payment';
    }
  } catch {
    return 'Missing or invalid amount';
  }

  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('Method Not Allowed');
  }

  let client;
  let transactionOpen = false;

  try {
    const secret = requiredEnv('NOWPAYMENTS_IPN_SECRET');
    const rawBody = await readRawBody(req);

    let data;
    try {
      data = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new HttpError(400, 'Invalid JSON');
    }

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new HttpError(400, 'Invalid payload');
    }

    if (
      !verifySignature(
        data,
        req.headers['x-nowpayments-sig'],
        secret
      )
    ) {
      throw new HttpError(403, 'Invalid signature');
    }

    const paymentId = identifier(data.payment_id);

    // 非 finished 状态不写入“付款完成”标记。
    if (data.payment_status !== 'finished') {
      return res.status(200).json({ received: true, processed: false });
    }

    client = await getPool().connect();

    await client.query('BEGIN');
    transactionOpen = true;
    await client.query("SET LOCAL lock_timeout = '5s'");

    // 所有付款更新接口都应使用同一订单锁定约定。
    const lookup = await client.query(
      `SELECT shopify_order_id
       FROM nowpayments_payments
       WHERE payment_id = $1`,
      [paymentId]
    );

    if (!lookup.rows[0]) {
      // 不确认成功，允许付款映射保存后重新处理。
      throw new Error('Payment mapping not found');
    }

    const orderId = lookup.rows[0].shopify_order_id;

    if (!/^\d+$/.test(orderId)) {
      throw new Error('Invalid mapped Shopify order ID');
    }

    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`nowpayments:order:${orderId}`]
    );

    const result = await client.query(
      `SELECT *
       FROM nowpayments_payments
       WHERE payment_id = $1
       FOR UPDATE`,
      [paymentId]
    );

    const mapping = result.rows[0];

    if (!mapping || mapping.shopify_order_id !== orderId) {
      throw new Error('Payment mapping changed');
    }

    if (mapping.processed_at) {
      await client.query('COMMIT');
      transactionOpen = false;
      return res.status(200).json({ received: true, duplicate: true });
    }

    let reviewReason = paymentMismatch(data, mapping);

    const shop = getShop();
    const token = await getShopifyAccessToken(shop);

    const orderResult = await shopifyRequest(
      shop,
      token,
      `/orders/${orderId}.json`
    );

    const order = orderResult.order;
    if (!order) throw new Error('Shopify order response missing');

    if (!reviewReason) {
      if (order.cancelled_at) {
        reviewReason = 'Order cancelled';
      } else if (
        currency(order.currency) !== currency(mapping.price_currency)
      ) {
        reviewReason = 'Shopify order currency mismatch';
      } else if (
        !positiveDecimal(
          order.current_total_price ?? order.total_price
        ).eq(mapping.price_amount)
      ) {
        reviewReason = 'Shopify order total mismatch';
      }
    }

    if (reviewReason) {
      await client.query(
        `UPDATE nowpayments_payments
         SET review_reason = $2, updated_at = NOW()
         WHERE payment_id = $1`,
        [paymentId, reviewReason]
      );

      await client.query('COMMIT');
      transactionOpen = false;

      console.warn('Payment saved for manual review:', paymentId);
      return res.status(200).json({
        received: true,
        manualReview: true,
      });
    }

    const metaResult = await shopifyRequest(
      shop,
      token,
      `/orders/${orderId}/metafields.json` +
        '?namespace=nowpayments&key=payment_status'
    );

    if (!Array.isArray(metaResult.metafields)) {
      throw new Error('Invalid metafield response');
    }

    const existing = metaResult.metafields.find(
      item =>
        item.namespace === 'nowpayments' &&
        item.key === 'payment_status'
    );

    const metafield = {
      namespace: 'nowpayments',
      key: 'payment_status',
      value: 'paid',
      type: 'single_line_text_field',
      ...(existing ? { id: existing.id } : {}),
    };

    await shopifyRequest(
      shop,
      token,
      existing
        ? `/metafields/${existing.id}.json`
        : `/orders/${orderId}/metafields.json`,
      existing ? 'PUT' : 'POST',
      { metafield }
    );

    // 重试使用相同标记，避免重复追加同一付款备注。
    const marker = `[NOWPayments payment:${paymentId}]`;
    const previousNote = order.note || '';

    if (!previousNote.includes(marker)) {
      const message =
        `${marker} Crypto payment completed; ` +
        'recorded only, Shopify payment status unchanged.';

      await shopifyRequest(
        shop,
        token,
        `/orders/${orderId}.json`,
        'PUT',
        {
          order: {
            id: orderId,
            note: [previousNote, message].filter(Boolean).join('\n'),
          },
        }
      );
    }

    await client.query(
      `UPDATE nowpayments_payments
       SET processed_at = NOW(),
           review_reason = NULL,
           updated_at = NOW()
       WHERE payment_id = $1`,
      [paymentId]
    );

    await client.query('COMMIT');
    transactionOpen = false;

    console.log('Payment metadata recorded:', paymentId);
    return res.status(200).json({ received: true, processed: true });
  } catch (error) {
    if (transactionOpen && client) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // 主错误继续返回非成功状态。
      }
    }

    console.error('IPN processing failed:', error.message);

    const status = error instanceof HttpError ? error.status : 503;

    return res
      .status(status)
      .send(status === 503 ? 'Processing failed; retry required' : error.message);
  } finally {
    client?.release();
  }
}
