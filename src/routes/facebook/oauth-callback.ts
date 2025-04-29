// backend/src/routes/facebook/oauth-callback.ts
import express from "express";
import axios from "axios";

const router = express.Router();

// Endpoint para recibir el "code" de Facebook
router.get("/api/facebook/oauth-callback", async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).send("No code provided");
  }

  try {
    const appId = process.env.FB_APP_ID!;
    const appSecret = process.env.FB_APP_SECRET!;
    const redirectUri = "https://api.aamy.ai/api/facebook/oauth-callback"; // Tu redirect_uri registrado

    // 1. Intercambiar el code por un Access Token
    const tokenResponse = await axios.get(
      "https://graph.facebook.com/v19.0/oauth/access_token",
      {
        params: {
          client_id: appId,
          redirect_uri: redirectUri,
          client_secret: appSecret,
          code,
        },
      }
    );

    const accessToken = tokenResponse.data.access_token;

    // 2. Obtener las páginas asociadas al usuario
    const pagesResponse = await axios.get(
      "https://graph.facebook.com/v19.0/me/accounts",
      {
        params: {
          access_token: accessToken,
        },
      }
    );

    const pages = pagesResponse.data.data;

    if (!pages || pages.length === 0) {
      return res.status(400).send("No se encontraron páginas de Facebook.");
    }

    const page = pages[0]; // Puedes luego permitir elegir si hay varias
    const pageId = page.id;
    const pageAccessToken = page.access_token;

    // 3. Obtener Instagram Business ID (si tiene)
    const igResponse = await axios.get(
      `https://graph.facebook.com/v19.0/${pageId}?fields=instagram_business_account`,
      {
        params: {
          access_token: pageAccessToken,
        },
      }
    );

    const instagramBusinessAccount = igResponse.data.instagram_business_account;
    const instagramId = instagramBusinessAccount?.id || null;

    // 4. 🚨 Aquí debes guardar en tu base de datos:
    //    - tenant_id (todavía no lo estamos recibiendo en este flujo, lo agregaremos después)
    //    - pageId
    //    - pageAccessToken
    //    - instagramId

    console.log("✅ Conexión exitosa");
    console.log({ pageId, pageAccessToken, instagramId });

    // 5. Redirigir de vuelta al dashboard
    return res.redirect("https://www.aamy.ai/dashboard/meta-config?connected=success");
  } catch (error) {
    console.error("❌ Error en OAuth Callback:", error);
    return res.status(500).send("Error during OAuth callback.");
  }
});

export default router;
