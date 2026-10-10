export default async function handler(req, res) {
  const { shop, code, hmac } = req.query;

  if (!shop || !code) {
    return res.status(400).send("Missing shop or code");
  }

  const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
  const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;

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
    // 拿到access_token，这里你可以存入数据库
    return res.send(`
      <h1>授权成功</h1>
      <p>店铺：${shop}</p>
      <p>Access Token：${data.access_token}</p>
    `);
  } else {
    return res.status(400).json(data);
  }
}