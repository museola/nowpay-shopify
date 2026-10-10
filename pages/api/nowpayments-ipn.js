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

  // ========== 【调试：临时注释IPN签名校验】上线务必取消注释 ==========
  // const hmacHeader = req.headers['x-nowpayments-sig'];
  // const npSecret = process.env.NOWPAYMENTS_IPN_SECRET;
  // const sorted = Object.keys(data).sort();
  // let str = '';
  // for (const k of sorted) {
  //   if (k !== 'signature') {
  //     str += `${k}${data[k]}`;
  //   }
  // }
  // const hash = createHmac('sha512', npSecret).update(str).digest('hex');
  // if (hash !== hmacHeader) {
  //   console.log("NowPayments IPN HMAC校验失败");
  //   return res.status(403).end();
  // }
  // =====================================================================

  console.log("✅ NowPayments IPN通知：", data);
  // 👉 恢复这两行！之前被注释掉了
  const orderId = data.order_id;
  const paymentStatus = data.payment_status;

  // 仅支付成功时更新Shopify订单
  if (paymentStatus === 'finished') {
    try {
      // 更新订单metafield标记支付状态
      await fetch(`https://${process.env.SHOPIFY_SHOP}/admin/api/2026-10/orders/${orderId}/metafields.json`, {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN,
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
      // 添加订单备注
      await fetch(`https://${process.env.SHOPIFY_SHOP}/admin/api/2026-10/orders/${orderId}.json`, {
        method: "PUT",
        headers: {
          "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN,
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
