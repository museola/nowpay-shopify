import crypto from 'crypto';

export default async function handler(req, res) {
  const { shop, code, hmac } = req.query;

  if (!shop || !code || !hmac) {
    return res.status(400).send("Missing shop, code or hmac");
  }

  const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
  const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;

  // HMAC 校验逻辑
  const queryParams = { ...req.query };
  delete queryParams.hmac;
  const sortedPairs = Object.entries(queryParams).sort(([a], [b]) => a.localeCompare(b));
  const queryString = sortedPairs.map(([k, v]) => `${k}=${v}`).join('');
  const calculatedHmac = crypto.createHmac('sha256', SHOPIFY_API_SECRET).update(queryString).digest('hex');

  if (calculatedHmac !== hmac) {
    return res.status(403).send("HMAC validation failed, request invalid");
  }

  const tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      client_id: SHOPIFY_API_KEY,
      client_secret: SHOPIFY_API_SECRET,
      code
    })
  });

  const data = await tokenResponse.json();

  if (data.access_token) {
    // 拿到 access_token，可保存到数据库，绑定店铺
    return res.send(`
      <h1>✅ Shopify 授权成功</h1>
      <p>店铺域名：${shop}</p>
      <p>Access Token：${data.access_token}</p>
    `);
  } else {
    return res.status(400).json(data);
  }
}
