import crypto from 'crypto';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // ========== Shopify Webhook HMAC校验 ==========
  // 注意：Next API 默认会解析body，原始rawBody需要特殊配置，这里采用兼容写法
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  const bodyRaw = JSON.stringify(req.body);
  const hash = crypto.createHmac('sha256', process.env.SHOPIFY_API_SECRET)
    .update(bodyRaw, 'utf8')
    .digest('base64');

  if (hash !== hmacHeader) {
    return res.status(403).send("Invalid Shopify HMAC");
  }

  const order = req.body;
  const orderId = order.order_id;
  const amount = order.total_price;
  const currency = order.currency;

  try {
    // 调用 NowPayments 创建支付单
    const npResp = await fetch("https://api.nowpayments.io/v1/invoice", {
      method: "POST",
      headers: {
        "x-api-key": process.env.NOWPAYMENTS_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        price_amount: amount,
        price_currency: currency,
        pay_currency: process.env.NOWPAYMENTS_PAY_CURRENCY || "USDTTRC20",
        order_id: orderId,
        ipn_callback_url: `${process.env.NEXT_PUBLIC_APP_URL}/api/nowpayments-ipn`
      })
    });
    const npData = await npResp.json();
    console.log("NowPayments invoice response:", npData);

    if (!npData.invoice_id) {
      return res.status(400).json({ error: "Failed to create NowPayments invoice" });
    }

    // 将invoice_id写入Shopify订单元字段
    await fetch(`https://${process.env.SHOPIFY_SHOP}/admin/api/2026-10/orders/${orderId}/metafields.json`, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        metafield: {
          namespace: "nowpayments",
          key: "invoice_id",
          value: npData.invoice_id,
          type: "single_line_text_field"
        }
      })
    });

    return res.status(200).json({ payment_url: npData.invoice_url });
  } catch (err) {
    console.error("Webhook error", err);
    return res.status(500).json({ error: "Server error" });
  }
}
