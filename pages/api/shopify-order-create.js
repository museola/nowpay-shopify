import crypto from 'crypto';

export const config = {
  api: {
    bodyParser: false,
  },
};

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  const WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!WEBHOOK_SECRET) {
    console.error('ERROR: SHOPIFY_WEBHOOK_SECRET is missing');
    return res.status(500).send('Server config error: missing webhook secret');
  }

  try {
    const rawBody = await readRawBody(req);
    const hmacHeader = req.headers['x-shopify-hmac-sha256'];

    if (!hmacHeader) {
      console.error('Missing x-shopify-hmac-sha256 header');
      return res.status(400).send('Missing HMAC header');
    }

    const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
    const digest = Buffer.from(hmac.update(rawBody).digest('base64'), 'utf8');
    const checksum = Buffer.from(hmacHeader, 'utf8');

    const isValid = crypto.timingSafeEqual(digest, checksum);
    if (!isValid) {
      console.error('HMAC signature invalid');
      return res.status(403).send('Invalid signature');
    }

    console.log('✅ Shopify Webhook HMAC verify success');
    const orderData = JSON.parse(rawBody);
    console.log('Received order:', orderData.order?.name);

    // =====在这里追加你的订单业务代码=====

    return res.status(200).send('ok');
  } catch (err) {
    console.error('Webhook handler error:', err);
    return res.status(500).send('Internal server error');
  }
}
