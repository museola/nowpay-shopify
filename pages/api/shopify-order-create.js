import crypto from 'crypto';
import fetch from 'node-fetch';

export default async function handler(req, res) {
  if(req.method !== 'POST') return res.status(405).end();
  // Shopify webhook HMAC验签
  const hmac = req.headers['x-shopify-hmac-sha256'];
  const body = JSON.stringify(req.body);
  const hash = crypto.createHmac('sha256', process.env.SHOPIFY_API_SECRET)
    .update(body)
    .digest('base64');
  if(hash !== hmac) return res.status(403).send('Invalid Shopify HMAC');

  const order = req.body;
  const orderId = order.id;
  const amount = order.total_price;
  const currency = order.currency;

  //调用NowPayments创建支付单
  const npResp = await fetch('https://api.nowpayments.io/v1/invoice', {
    method:'POST',
    headers:{
      'x-api-key': process.env.NOWPAYMENTS_API_KEY,
      'Content-Type':'application/json'
    },
    body: JSON.stringify({
      price_amount: amount,
      price_currency: currency,
      pay_currency: 'USDTTRC20',
      order_id: orderId,
      ipn_callback_url: `${process.env.VERCEL_URL}/api/nowpayments-ipn`
    })
  });
  const npData = await npResp.json();
  //保存invoice id到订单元字段
  await fetch(`https://${process.env.SHOPIFY_SHOP}/admin/api/2026-10/orders/${orderId}/metafields.json`,{
    method:'POST',
    headers:{
      'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN,
      'Content-Type':'application/json'
    },
    body: JSON.stringify({
      metafield:{
        namespace:'nowpayments',
        key:'invoice_id',
        value: npData.invoice_id,
        type:'single_line_text_field'
      }
    })
  })
  res.status(200).json({payment_url: npData.invoice_url});
}