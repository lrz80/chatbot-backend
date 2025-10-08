import { Router, Request, Response } from "express";
import * as qs from "querystring";

const router = Router();

const FB_APP_ID = process.env.FB_APP_ID!;
const PUBLIC_BACKEND_URL = process.env.PUBLIC_BACKEND_URL || "https://api.aamy.ai";
const REDIRECT_URI = `${PUBLIC_BACKEND_URL}/api/facebook/oauth-callback`;

router.get("/api/facebook/oauth-start", async (_req: Request, res: Response) => {
  try {
    const params = {
      client_id: FB_APP_ID,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: [
        "pages_show_list",
        "pages_read_engagement",
        "pages_messaging",
        "instagram_basic",
        "instagram_manage_messages",
      ].join(","),
      state: "aamy_meta_state",
    };

    const url = `https://www.facebook.com/v19.0/dialog/oauth?${qs.stringify(params)}`;
    return res.redirect(url);
  } catch (e) {
    console.error("❌ /oauth-start error:", e);
    return res.status(500).send("OAuth start failed");
  }
});

export default router;
