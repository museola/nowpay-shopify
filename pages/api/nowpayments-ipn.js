import crypto from 'crypto';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const body = req.body;
  const signature = req.headers['x-nowpayments-sig'];

  // 校验body与签名
  if (!body || !signature) {
    return res.status(400).send('Missing body or signature');
  }

  // Nowpayments IPN签名校验
  const sortedKeys = Object.keys(body).sort();
  const raw = JSON.stringify(sortedKeys.reduce((acc, k) => {
    acc[k] = body[k];
    return acc;
  }, {}));
  const hmac = crypto.createHmac('sha512', process.env.NOWPAYMENTS_IPN_SECRET).update(raw).digest('hex');

  if (hmac !== signature) {
    return res.status(403).send('Bad IPN signature');
  }

  // 只处理finished状态
  if (body.payment_status !== 'finished') {
    return res.send('ok');
  }

  if (!body.order_id) {
    return res.status(400).send('Missing order_id');
  }

  const shopifyOrderId = `gid://shopify/Order/${body.order_id}`;
  const gql = `
    mutation markPaid($id: ID!){
      orderMarkAsPaid(input:{id:$id}){
        order{
          id
          financialStatus
        }
        userErrors{
          field
          message
        }
      }
    }
  `;
  const variables = { id: shopifyOrderId };

  try {
    const resp = await fetch(`https://${process.env.SHOPIFY_SHOP}/admin/api/2026-10/graphql.json`, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query: gql, variables })
    });
    const result = await resp.json();
    console.log('GraphQL result', result);

    if (result.errors || result.data?.orderMarkAsPaid?.userErrors?.length > 0) {
      return res.status(400).send('GraphQL error');
    }
    return res.send('success');
  } catch (err) {
    console.error('IPN API error', err);
    return res.status(500).send('Server error');
  }
}
