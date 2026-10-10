// pages/api/auth/callback.js
import axios from "axios";

export default async function handler(req, res) {
  const { code, shop } = req.query;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

  if (!code || !shop) {
    return res.status(400).send("Missing code or shop");
  }

  try {
    const tokenResp = await axios.post(`https://${shop}/admin/oauth/access_token`, {
      client_id: clientId,
      client_secret: clientSecret,
      code: code,
    });

    const accessToken = tokenResp.data.access_token;
    console.log("✅ 获取到Shopify AccessToken：", accessToken);

    return res.send("✅ App 安装成功！你可以关闭这个窗口");
  } catch (err) {
    console.error("OAuth回调错误：", err.response?.data || err.message);
    return res.status(500).send("OAuth callback error");
  }
}
