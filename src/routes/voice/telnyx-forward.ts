import express, { Request, Response } from "express";

const router = express.Router();

router.post("/telnyx-forward", async (req: Request, res: Response) => {
  try {
    const destinationNumber = "+13057206515"; // Tu número personal donde recibirás el código

    return res.json({
      instructions: [
        {
          command: "dial",
          to: destinationNumber,
          from: req.body.data.payload.to,
          timeout_secs: 30
        }
      ]
    });
  } catch (error) {
    console.error("Error forwarding call:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
