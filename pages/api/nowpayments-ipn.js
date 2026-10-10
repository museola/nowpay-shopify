const { createHmac } = require('crypto');
export const config = {
  api: {
    bodyParser: false,
  },
};
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).end();
  }
  // 读取原始body
  const buffers = [];
  for await (const chunk of req) buffers.push(chunk);
  const rawBody = Buffer.concat(buffers).toString();
  const data = JSON.parse(rawBody);

  // NowPayments IPN签名校验（生产环境启用）
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

  // 仅支付成功时更新Shopify订单
  if (paymentStatus === 'finished') {
    try {
      const shop = process.env.SHOPIFY_SHOP;
      const token = process.env.SHOPIFY_ADMIN_TOKEN;
      const apiVersion = "2026-10";

      // 1. 查询该订单下nowpayments.payment_status的metafield
      const getMetaRes = await fetch(`https://${shop}/admin/api/${apiVersion}/orders/${orderId}/metafields.json?namespace=nowpayments&key=payment_status`, {
        headers: {
          "X-Shopify-Access-Token": token,
          "Content-Type": "application/json",
        },
      });
      const metaData = await getMetaRes.json();
      const existingMeta = metaData.metafields?.[0];

      // 2. 存在则PUT更新，不存在POST新建
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
          "X-Shopify-Access-Token": token,
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
          "X-Shopify-Access-Token": token,
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
