const { createHmac } = require('crypto');

export const config = {
  api: {
    bodyParser: false, // 关闭自动解析，拿到原始raw body
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // 读取原始body buffer
  const buffers = [];
  for await (const chunk of req) {
    buffers.push(chunk);
  }
  const rawBody = Buffer.concat(buffers).toString();

  // Shopify HMAC校验
  //const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  //const hash = createHmac('sha256', process.env.SHOPIFY_API_SECRET)
    //.update(rawBody, 'utf8')
   // .digest('base64');

 // if (hash !== hmacHeader) {
   // return res.status(403).send("Invalid Shopify HMAC");
 // }

  // 把原始字符串转成json对象，后面业务代码继续使用
  const order = JSON.parse(rawBody);
  const orderId = order.order_id;
  const amount = order.total_price;
  const currency = order.currency;

  try {
    // 下面你原来 NowPayments + Shopify metafield 的代码保持不动
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
        "Content-Type": "application/json",
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
