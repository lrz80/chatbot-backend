import { Router } from "express";
import { saveSquareConnection } from "../../lib/appointments/booking/providers/saveSquareConnection";

const router = Router();

router.post("/connect", async (req, res) => {
  try {
    const tenantId = String(req.body?.tenantId || "").trim();
    const accessToken = String(req.body?.accessToken || "").trim();
    const locationId = String(req.body?.locationId || "").trim();
    const environment =
      String(req.body?.environment || "production").trim().toLowerCase() ===
      "sandbox"
        ? "sandbox"
        : "production";

    const result = await saveSquareConnection({
      tenantId,
      accessToken,
      locationId,
      environment,
    });

    if (!result.ok) {
      return res.status(result.status || 500).json(result);
    }

    return res.status(200).json(result);
  } catch (error) {
    console.error("[SQUARE_CONNECT_ROUTE] unexpected error", error);
    return res.status(500).json({
      ok: false,
      error: "INTERNAL_SERVER_ERROR",
    });
  }
});

export default router;