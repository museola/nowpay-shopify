import crypto from 'crypto';

export const config = {
  api: {
    bodyParser: false,
  },
};

async function readRawBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    );
  }

  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('Method Not Allowed');
  }

  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;

  if (!secret) {
    console.error('SHOPIFY_WEBHOOK_SECRET is missing');
    return res.status(500).send('Server configuration error');
  }

  try {
    const signature = req.headers['x-shopify-hmac-sha256'];

    if (typeof signature !== 'string' || !signature) {
      return res.status(401).send('Missing signature');
    }

    const rawBody = await readRawBody(req);

    const expected = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest();

    const received = Buffer.from(signature, 'base64');

    if (
      received.length !== expected.length ||
      !crypto.timingSafeEqual(expected, received)
    ) {
      return res.status(403).send('Invalid signature');
    }

    let orderData;

    try {
      orderData = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return res.status(400).send('Invalid JSON');
    }

    console.log('Shopify webhook verified');
    console.log('Received order:', orderData.name);

    // 在这里处理订单业务。
    // 涉及创建付款或更新订单时，需要持久化去重，
    // 避免同一通知重复执行。

    return res.status(200).send('ok');
  } catch (err) {
    console.error('Webhook handler error:', err);
    return res.status(500).send('Internal server error');
  }
}
