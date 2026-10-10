import crypto from 'crypto';
import fetch from 'node-fetch';

export default async function handler(req, res) {
  if(req.method !== 'POST') return res.status(405).end();
  const body = req.body;
  const signature = req.headers['x-nowpayments-sig'];
  //NowPayments IPN验签
  const sorted = Object.keys(body).sort().reduce((acc,k)=>{acc[k]=body[k];return acc},{});
  const raw = JSON.stringify(sorted);
  const hmac = crypto.createHmac('sha512', process.env.NOWPAYMENTS_IPN_SECRET).update(raw).digest('hex');
  if(hmac !== signature) return res.status(403).send('Bad IPN signature');

  if(body.payment_status !== 'finished') return res.send('ok');

  const shopifyOrderId = `gid://shopify/Order/${body.order_id}`;
  const gql = `mutation markPaid($oid:ID!){
    orderMarkAsPaid(input:{orderId:$oid}){
      order{id financialStatus}
      userErrors{field message}
    }
  }`;
  await fetch(`https://${process.env.SHOPIFY_SHOP}/admin/api/2026-10/graphql.json`,{
    method:'POST',
    headers:{
      'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN,
      'Content-Type':'application/json'
    },
    body: JSON.stringify({query:gql, variables:{oid:shopifyOrderId}})
  })
  res.send('success');
}