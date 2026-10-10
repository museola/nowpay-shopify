import crypto from 'crypto';

export default async function handler(req, res) {
  // 只允许POST请求
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  // ✅ 在handler内部读取秘钥，避免顶层变量undefined问题
  const WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!WEBHOOK_SECRET) {
    console.error('ERROR: SHOPIFY_WEBHOOK_SECRET is missing');
    return res.status(500).send('Server config error: missing webhook secret');
  }

  try {
    // Shopify 原始body（必须用原始payload，不能用JSON解析后的对象，否则签名校验失败）
    const rawBody = JSON.stringify(req.body);
    const hmacHeader = req.headers['x-shopify-hmac-sha256'];

    if (!hmacHeader) {
      console.error('Missing x-shopify-hmac-sha256 header');
      return res.status(400).send('Missing HMAC header');
    }

    // 计算HMAC
    const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
    const digest = Buffer.from(hmac.update(rawBody).digest('base64'), 'utf8');
    const checksum = Buffer.from(hmacHeader, 'utf8');

    // 安全比对，防止时序攻击
    const isValid = crypto.timingSafeEqual(digest, checksum);

    if (!isValid) {
      console.error('HMAC signature invalid');
      return res.status(403).send('Invalid signature');
    }

    console.log('✅ Shopify Webhook HMAC verify success');
    // ========== 这里放你的订单业务逻辑 ==========
    const orderData = req.body;
    console.log('Received order:', orderData.order?.name);

    return res.status(200).send('ok');
  } catch (err) {
    console.error('Webhook handler error:', err);
    return res.status(500).send('Internal server error');
  }
}
