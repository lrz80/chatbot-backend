import { Router, Request, Response } from "express";
import axios from "axios";

const router = Router();

const redirectUri = process.env.NEXT_PUBLIC_WA_REDIRECT_URI!;

router.get("/meta/whatsapp-redirect", async (req: Request, res: Response) => {
  const { code, state } = req.query;

  console.log("📩 Recibido callback desde Meta:", { code, state });

  if (!code) {
    return res.status(400).send("❌ Falta el parámetro code");
  }

  try {
    const tokenResponse = await axios.get(
      `https://graph.facebook.com/v18.0/oauth/access_token`,
      {
        params: {
          client_id: process.env.META_APP_ID,
          client_secret: process.env.META_APP_SECRET,
          redirect_uri: redirectUri,
          code,
        },
      }
    );

    console.log("🔑 Token recibido desde Meta:", tokenResponse.data);

    res.redirect(
      `/meta/whatsapp-redirect-success?access_token=${tokenResponse.data.access_token}&state=${state}`
    );
  } catch (error: any) {
    console.error("❌ Error al intercambiar token:", error.response?.data || error.message);
    res.redirect("/meta/whatsapp-redirect?error=true");
  }
});

export default router;
