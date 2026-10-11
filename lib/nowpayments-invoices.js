// Save this file as lib/nowpayments-invoices.js in the project root.
// Node.js / Next.js Pages Router. Requires pg and decimal.js.
import pg from 'pg';
import Decimal from 'decimal.js';
const { Pool } = pg;
let pool;
function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}
function db() {
  if (!pool) pool = new Pool({ connectionString: env('DATABASE_URL'), max: 3,
    connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 });
  return pool;
}
export function numericId(value) {
  if (typeof value === 'string' && /^\d+$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  throw new Error('Invalid numeric identifier');
}
function amount(value) {
  if (!['string','number'].includes(typeof value) || String(value).trim() === '') throw new Error('Invalid amount');
  const number = new Decimal(value);
  if (!number.isFinite() || !number.gt(0)) throw new Error('Invalid amount');
  return number;
}
function httpsUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Invalid HTTPS URL');
  return url;
}
async function jsonRequest(url, options, label) {
  const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok) {
    if (label === 'NOWPayments invoice') {
      try {
        const details = await response.json();
        console.error('NOWPayments invoice rejected:', {
          status: response.status,
          code: String(details.code ?? 'unavailable').slice(0, 100),
          message: String(details.message ?? 'unavailable').slice(0, 500),
        });
      } catch {
        console.error('NOWPayments invoice rejected:', { status: response.status });
      }
    }
    throw new Error(`${label} HTTP ${response.status}`);
  }
  return response.json();
}

// Invoke only after Shopify raw-body HMAC verification and payment-method filtering.
export async function createInvoiceAndEmail(order) {
  const orderId = numericId(order.id);
  const price = amount(order.current_total_price ?? order.total_price);
  const priceCurrency = String(order.currency || '').toLowerCase();
  if (!/^[a-z]{3}$/.test(priceCurrency)) throw new Error('Invalid order currency');
  const recipient = order.email || order.contact_email;
  if (typeof recipient !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    throw new Error('Order has no usable contact email; manual review required');
  }
  // Null means the customer selects the payment currency on the hosted invoice.
  const payCurrency = null;
  const apiKey = env('NOWPAYMENTS_API_KEY');
  const callback = httpsUrl(env('NOWPAYMENTS_IPN_CALLBACK_URL')).toString();
  const from = env('RESEND_FROM_EMAIL');
  env('RESEND_API_KEY');
  const numericPrice = price.toNumber();
  if (!new Decimal(numericPrice).eq(price)) throw new Error('Price cannot be represented safely');
  const orderName = String(order.name || orderId).replace(/[\r\n]/g, ' ');

  // Migration guard: do not create an invoice for an order already handled by the old direct-payment code.
  const legacyTable = await db().query("SELECT to_regclass('public.nowpayments_order_jobs') AS table_name");
  if (legacyTable.rows[0]?.table_name) {
    const legacy = await db().query('SELECT state FROM nowpayments_order_jobs WHERE shopify_order_id=$1', [orderId]);
    if (legacy.rows.length) throw new Error('Order belongs to the old direct-payment workflow; manual review required');
  }
  // Persist before contacting the payment provider. Unknown outcomes do not retry creation.
  const inserted = await db().query(
    `INSERT INTO nowpayments_invoices
      (shopify_order_id, merchant_order_id, order_name, recipient_email,
       price_amount, price_currency, pay_currency, state)
     VALUES ($1,$1,$2,$3,$4,$5,$6,'creating')
     ON CONFLICT (shopify_order_id) DO NOTHING RETURNING shopify_order_id`,
    [orderId, orderName, recipient, price.toFixed(), priceCurrency, payCurrency]);

  if (inserted.rows.length) {
    try {
      const invoice = await jsonRequest('https://api.nowpayments.io/v1/invoice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({ price_amount: numericPrice, price_currency: priceCurrency,
          order_id: orderId,
          order_description: `MuseOla order ${orderName}`, ipn_callback_url: callback })
      }, 'NOWPayments invoice');
      const invoiceId = numericId(invoice.id);
      const invoiceUrl = httpsUrl(invoice.invoice_url);
      if (invoiceUrl.hostname !== 'nowpayments.io' ||
          String(invoice.order_id) !== orderId ||
          String(invoice.price_currency).toLowerCase() !== priceCurrency ||
          !amount(invoice.price_amount).eq(price)) {
        throw new Error('Unexpected invoice response');
      }
      // Escape dynamic values before placing them in email HTML.
      const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      }[char]));
      const safeOrder = escapeHtml(orderName);
      const safeAmount = escapeHtml(`${price.toFixed()} ${priceCurrency.toUpperCase()}`);
      const safeLink = escapeHtml(invoiceUrl.toString());
      // Store the exact immutable email payload so retries have the same idempotency request.
      const emailPayload = { from, to: [recipient],
        html: `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f5f3;font-family:Arial,sans-serif;color:#222;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;"><tr><td style="padding:32px;">
              <h1 style="font-size:24px;margin:0 0 24px;">MuseOla</h1>
              <h2 style="font-size:20px;">Complete your payment</h2>
              <p>Thank you for your order ${safeOrder}.</p>
              <p>Order amount: <strong>${safeAmount}</strong></p>
              <p>Choose your preferred payment currency on the NOWPayments payment page.</p>
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;"><tr>
                <td align="left" bgcolor="#eceff1" style="border-radius:16px;border:1px solid #dee3e6;">
                  <a href="${safeLink}" target="_blank" rel="noopener noreferrer" aria-label="Pay your order with NOWPayments" style="display:block;padding:20px 28px;border-radius:16px;color:#13171c;text-decoration:none;font-family:Arial,sans-serif;">
                    <span style="display:block;font-size:15px;line-height:22px;color:#13171c;">Pay your order with crypto</span>
                    <span style="display:block;margin-top:6px;font-size:24px;line-height:30px;font-weight:bold;"><span style="color:#68aaff;">NOW</span><span style="color:#13171c;">Payments</span></span>
                    <span style="display:block;margin-top:8px;font-size:13px;line-height:18px;color:#13171c;">Pay now &#8594;</span>
                  </a>
                </td>
              </tr></table>
              <p style="font-size:13px;color:#555;">If the button does not work, copy this link into your browser:</p>
              <p style="font-size:13px;word-break:break-all;"><a href="${safeLink}" style="color:#222;">${safeLink}</a></p>
              <p style="font-size:13px;color:#555;">Follow the payment page for the exact amount, network, and any required Memo/Tag. Please do not pay twice. If you have already paid, wait for confirmation.</p>
              <p style="font-size:13px;color:#555;">This is a payment request, not a payment confirmation.</p>
            </td></tr></table>
          </td></tr></table>
        </body></html>`,
        subject: `Complete payment for your MuseOla order ${orderName}`,
        text: `Thank you for your MuseOla order ${orderName}.\n\n` +
          `Order amount: ${price.toFixed()} ${priceCurrency.toUpperCase()}\n\n` +
          `Complete your payment securely with NOWPayments:\n${invoiceUrl.toString()}\n\n` +
          `Follow the payment page for the exact amount, network, and any required Memo/Tag. ` +
          `Please do not pay twice. If you have already paid, wait for confirmation.\n\n` +
          `This email is a payment request, not a payment confirmation.\n\nMuseOla` };
      await db().query(
        `UPDATE nowpayments_invoices SET state='created', invoice_id=$2,
         invoice_url=$3, email_payload=$4::jsonb, updated_at=NOW()
         WHERE shopify_order_id=$1 AND state='creating'`,
        [orderId, invoiceId, invoiceUrl.toString(), JSON.stringify(emailPayload)]);
    } catch (error) {
      await db().query(
        `UPDATE nowpayments_invoices SET state='review',
         review_reason='Invoice creation outcome uncertain; check provider before retrying',
         updated_at=NOW() WHERE shopify_order_id=$1 AND state='creating'`, [orderId]);
      throw error;
    }
  }
  const result = await db().query('SELECT * FROM nowpayments_invoices WHERE shopify_order_id=$1', [orderId]);
  const record = result.rows[0];
  if (!record || record.state !== 'created') throw new Error('Invoice creation pending or requires manual review');
  return sendSavedEmail(orderId);
}

async function sendSavedEmail(orderId) {
  // Commit the initial attempt time before any external send; it survives a process crash.
  await db().query(`UPDATE nowpayments_invoices SET first_email_attempt=COALESCE(first_email_attempt,NOW())
    WHERE shopify_order_id=$1 AND state='created' AND email_accepted_at IS NULL`, [orderId]);
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    const result = await client.query('SELECT * FROM nowpayments_invoices WHERE shopify_order_id=$1 FOR UPDATE', [orderId]);
    const row = result.rows[0];
    if (row.email_accepted_at) {
      await client.query('COMMIT');
      return { invoiceCreated: true, emailAccepted: true, duplicate: true };
    }
    // Conservative limit, shorter than Resend's 24-hour idempotency window.
    const age = Date.now() - new Date(row.first_email_attempt).getTime();
    if (!Number.isFinite(age) || age > 23 * 60 * 60 * 1000) {
      await client.query(`UPDATE nowpayments_invoices SET
        review_reason='Email result unresolved beyond retry window; check Resend before resending',
        updated_at=NOW() WHERE shopify_order_id=$1`, [orderId]);
      await client.query('COMMIT');
      throw new Error('Email requires manual review; automatic retry disabled');
    }
    const sent = await jsonRequest('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env('RESEND_API_KEY')}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `museola-invoice/${row.invoice_id}` },
      body: JSON.stringify(row.email_payload)
    }, 'Resend');
    if (typeof sent.id !== 'string' || !sent.id) throw new Error('Invalid email response');
    await client.query(`UPDATE nowpayments_invoices SET email_accepted_at=NOW(),
      resend_email_id=$2, review_reason=NULL, updated_at=NOW() WHERE shopify_order_id=$1`, [orderId, sent.id]);
    await client.query('COMMIT');
    return { invoiceCreated: true, emailAccepted: true };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally { client.release(); }
}

// Invoke ONLY after NOWPayments HMAC verification, and only for finished payment IPNs.
// This links a signed provider payment to the invoice created from the Shopify order.
export async function ensureInvoicePaymentMapping(data) {
  const paymentId = numericId(data.payment_id);
  const invoiceId = numericId(data.invoice_id);
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    const result = await client.query('SELECT * FROM nowpayments_invoices WHERE invoice_id=$1 FOR UPDATE', [invoiceId]);
    const row = result.rows[0];
    if (!row || row.state !== 'created') throw new Error('Invoice mapping not ready');
    // Called only after IPN signature verification. Bind the chosen currency once.
    const selectedCurrency = typeof data.pay_currency === 'string'
      ? data.pay_currency.trim().toLowerCase() : '';
    let reason = null;
    if (!/^[a-z0-9]+$/.test(selectedCurrency)) reason = 'Invalid payment currency';
    else if (data.parent_payment_id != null && String(data.parent_payment_id) !== '') reason = 'Related or repeated deposit';
    else if (row.payment_id && row.payment_id !== paymentId) reason = 'Multiple payments for one invoice';
    else if (String(data.order_id) !== row.merchant_order_id) reason = 'Order reference mismatch';
    else if (String(data.price_currency).toLowerCase() !== row.price_currency ||
             (row.pay_currency !== null && selectedCurrency !== row.pay_currency)) reason = 'Currency mismatch';
    else {
      try {
        if (!amount(data.price_amount).eq(row.price_amount) ||
            amount(data.actually_paid).lt(amount(data.pay_amount))) reason = 'Amount mismatch or insufficient funds';
      } catch { reason = 'Invalid payment amount'; }
    }
    if (reason) {
      await client.query(`UPDATE nowpayments_invoices SET review_reason=$2, updated_at=NOW()
        WHERE invoice_id=$1`, [invoiceId, reason]);
      await client.query('COMMIT');
      return { manualReview: true };
    }
    const payAmount = amount(data.pay_amount);
    await client.query(`INSERT INTO nowpayments_payments
      (payment_id,shopify_order_id,merchant_order_id,price_amount,price_currency,pay_amount,pay_currency)
      VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (payment_id) DO NOTHING`,
      [paymentId,row.shopify_order_id,row.merchant_order_id,row.price_amount,row.price_currency,payAmount.toFixed(),selectedCurrency]);
    const existing = await client.query('SELECT * FROM nowpayments_payments WHERE payment_id=$1', [paymentId]);
    const mapping = existing.rows[0];
    if (!mapping || mapping.shopify_order_id !== row.shopify_order_id ||
        mapping.merchant_order_id !== row.merchant_order_id ||
        mapping.price_currency !== row.price_currency || mapping.pay_currency !== selectedCurrency ||
        !new Decimal(mapping.price_amount).eq(row.price_amount) || !new Decimal(mapping.pay_amount).eq(payAmount)) {
      throw new Error('Conflicting payment mapping');
    }
    await client.query(`UPDATE nowpayments_invoices SET payment_id=$2, pay_currency=$3, updated_at=NOW()
      WHERE invoice_id=$1`, [invoiceId,paymentId,selectedCurrency]);
    await client.query('COMMIT');
    return { mapped: true };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally { client.release(); }
}
