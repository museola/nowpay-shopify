export default async function handler(req, res) {
  const { shop } = req.query;

  if (!shop) {
    return res.status(400).send("Missing shop parameter. ?shop=yourshop.myshopify.com");
  }

  const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
  const SCOPES = "read_orders,write_products,read_customers";
  const APP_URL = process.env.NEXT_PUBLIC_APP_URL;

  const authUrl = `https://${shop}/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}&scope=${SCOPES}&redirect_uri=${APP_URL}/api/auth/callback`;

  res.redirect(authUrl);
}