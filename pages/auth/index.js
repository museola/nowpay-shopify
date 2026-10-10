// pages/api/auth/index.js
export default async function handler(req, res) {
  const { shop } = req.query;
  const clientId = process.env.SHOPIFY_CLIENT_ID;

  if (!shop) {
    return res.status(400).send("缺少 shop 参数，访问格式：/api/auth?shop=你的店铺.myshopify.com");
  }

  const authUrl = `https://${shop}/admin/oauth/authorize?client_id=${clientId}&scope=read_orders,write_orders&redirect_uri=https://nowpay-shopify.vercel.app/api/auth/callback`;

  res.redirect(authUrl);
}
