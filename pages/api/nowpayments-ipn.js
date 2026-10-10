const { createHmac } = require('crypto');
export const config = {
  api: {
    bodyParser: false,
  },
};

let cachedAccessToken = null;
let tokenExpireAt = 0;
async function getShopifyAccessToken(shop, clientId, clientSecret) {
  const now = Date.now() / 1000;
  if (cachedAccessToken && tokenExpireAt > now + 60) {
    return cachedAccessToken;
  }
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret
    })
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`获取token失败: ${JSON.stringify(data)}`);
  cachedAccessToken = data.access_token;
  tokenExpireAt = now + data.expires_in;
  return cachedAccessToken;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).end();
  }
  const buffers = [];
  for await (const chunk of req) buffers.push(chunk);
  const rawBody = Buffer.concat(buffers).toString();
  const data = JSON.parse(rawBody);

  // NowPayments IPN HMAC签名校验
  const hmacHeader = req.headers['x-nowpayments-sig'];
  const npSecret = process.env.NOWPAYMENTS_IPN_SECRET;
  const sorted = Object.keys(data).sort();
  let str = '';
  for (const k of sorted) {
    if (k !== 'signature') {
      str += `${k}${data[k]}`;
    }
  }
  const hash = createHmac('sha512', npSecret).update(str).digest('hex');
  if (hash !== hmacHeader) {
    console.log("NowPayments IPN HMAC校验失败");
    return res.status(403).end();
  }

  console.log("✅ NowPayments IPN通知：", data);
  const orderId = data.order_id;
  const paymentStatus = data.payment_status;

  if (paymentStatus === 'finished') {
    try {
      const shop = process.env.SHOPIFY_SHOP;
      const apiVersion = "2026-10";
      const accessToken = await getShopifyAccessToken(
        shop,
        process.env.SHOPIFY_CLIENT_ID,
        process.env.SHOPIFY_CLIENT_SECRET
      );

      // 查询现有metafield
      const getMetaRes = await fetch(`https://${shop}/admin/api/${apiVersion}/orders/${orderId}/metafields.json?namespace=nowpayments&key=payment_status`, {
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
            key: "payment_status",
            value: "paid",
            type: "single_line_text_field"
          }
        })
      });

      // 更新订单备注
      await fetch(`https://${shop}/admin/api/${apiVersion}/orders/${orderId}.json`, {
        method: "PUT",
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          order: {
            note: "Crypto payment completed via NowPayments"
          }
        })
      });
      console.log(`✅ Shopify订单 ${orderId} 更新成功，metafield+备注已写入`);
    } catch (err) {
      console.error("❌ 更新Shopify订单失败", err);
    }
  }
  return res.status(200).end();
}
