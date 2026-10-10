console.log("==== DEBUG SHOPIFY_WEBHOOK_SECRET ====");
console.log("Raw value:", process.env.SHOPIFY_WEBHOOK_SECRET);
console.log("Is defined?", typeof process.env.SHOPIFY_WEBHOOK_SECRET !== "undefined");
console.log("String length:", process.env.SHOPIFY_WEBHOOK_SECRET?.length);
const { createHmac } = require('crypto');
export const config = {
  api: {
    bodyParser: false,
  },
};

// 全局缓存access token
let cachedAccessToken = null;
let tokenExpireAt = 0;

async function getShopifyAccessToken(shop, clientId, clientSecret) {
  const now = Date.now() / 1000;
  // 预留60秒缓冲，避免临界过期
  if (cachedAccessToken && tokenExpireAt > now + 60) {
    return cachedAccessToken;
  }
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret
    })
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`获取Shopify Token失败: ${JSON.stringify(data)}`);
  }
  cachedAccessToken = data.access_token;
  tokenExpireAt = now + data.expires_in;
  return cachedAccessToken;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const buffers = [];
  for await (const chunk of req) buffers.push(chunk);
  const rawBody = Buffer.concat(buffers).toString();

  // Shopify Webhook HMAC校验（不变，使用App Secret）
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  const hash = createHmac('sha256', process.env.SHOPIFY_API_SECRET)
    .update(rawBody, 'utf8')
    .digest('base64');
  if (hash !== hmacHeader) {
    console.log("Shopify Webhook HMAC校验失败");
    return res.status(403).send("Invalid Shopify HMAC");
  }

  const order = JSON.parse(rawBody);
  const orderId = order.order_id;
  const amount = order.total_price;
  const currency = order.currency;
  const shop = process.env.SHOPIFY_SHOP;
  const apiVersion = "2026-10";

  try {
    // 调用NowPayments创建invoice
    const npResp = await fetch("https://api.nowpayments.io/v1/invoice", {
      method: "POST",
      headers: {
        "x-api-key": process.env.NOWPAYMENTS_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        price_amount: amount,
        price_currency: currency,
        pay_currency: process.env.NOWPAYMENTS_PAY_CURRENCY || "USDTTRC20",
        order_id: orderId,
        ipn_callback_url: "https://nowpay-shopify.vercel.app/api/nowpayments-ipn"
      })
    });
    const npData = await npResp.json();
    console.log("NowPayments invoice response:", npData);
    if (!npData.id) {
      return res.status(400).json({
        error: "Failed to create NowPayments invoice",
        np_detail: npData
      });
    }

    // 获取短期access_token
    const accessToken = await getShopifyAccessToken(
      shop,
      process.env.SHOPIFY_CLIENT_ID,
      process.env.SHOPIFY_CLIENT_SECRET
    );

    // Metafield Upsert：存在更新，不存在新建
    const getMetaRes = await fetch(`https://${shop}/admin/api/${apiVersion}/orders/${orderId}/metafields.json?namespace=nowpayments&key=invoice_id`, {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    });
    const metaData = await getMetaRes.json();
    const existingMeta = metaData.metafields?.[0];
    let metaUrl, metaMethod;
    if (existingMeta?.id) {
      metaUrl = `https://${shop}/admin/api/${apiVersion}/metafields/${existingMeta.id}.json`;
      metaMethod = "PUT";
    } else {
      metaUrl = `https://${shop}/admin/api/${apiVersion}/orders/${orderId}/metafields.json`;
      metaMethod = "POST";
    }
    await fetch(metaUrl, {
      method: metaMethod,
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        metafield: {
          namespace: "nowpayments",
          key: "invoice_id",
          value: npData.id,
          type: "single_line_text_field"
        }
      })
    });
    return res.status(200).json({ payment_url: npData.invoice_url });
  } catch (err) {
    console.error("Webhook error", err);
    return res.status(500).json({ error: "Server error", detail: err.message });
  }
}
