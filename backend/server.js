require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const {
  INTUIT_CLIENT_ID,
  INTUIT_CLIENT_SECRET,
  INTUIT_REDIRECT_URI
} = process.env;

// Home/status
app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: "Lesik Receipt Automation",
    version: "1.0.0"
  });
});

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString()
  });
});

// Start QuickBooks authorization
app.get("/auth/intuit", (req, res) => {
  const state = Math.random().toString(36).substring(2);

  const authUrl =
    "https://appcenter.intuit.com/connect/oauth2" +
    "?client_id=" + encodeURIComponent(INTUIT_CLIENT_ID) +
    "&response_type=code" +
    "&scope=com.intuit.quickbooks.accounting" +
    "&redirect_uri=" + encodeURIComponent(INTUIT_REDIRECT_URI) +
    "&state=" + encodeURIComponent(state);

  res.redirect(authUrl);
});

// QuickBooks OAuth callback
app.get("/auth/intuit/callback", async (req, res) => {
  const { code, realmId, state } = req.query;

  if (!code) {
    return res.status(400).send("Authorization code missing.");
  }

  try {
    const tokenResponse = await axios.post(
      "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
      new URLSearchParams({
        grant_type: "authorization_code",
        code: code,
        redirect_uri: INTUIT_REDIRECT_URI
      }).toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Authorization":
            "Basic " +
            Buffer.from(
              INTUIT_CLIENT_ID + ":" + INTUIT_CLIENT_SECRET
            ).toString("base64")
        }
      }
    );

    res.json({
      success: true,
      message: "QuickBooks connected successfully.",
      realmId: realmId,
      access_token_received: !!tokenResponse.data.access_token,
      refresh_token_received: !!tokenResponse.data.refresh_token
    });

  } catch (error) {
    console.error(
      "QuickBooks OAuth error:",
      error.response?.data || error.message
    );

    res.status(500).json({
      success: false,
      error: "QuickBooks authorization failed."
    });
  }
});

app.listen(PORT, () => {
  console.log(
    `Lesik Receipt Automation backend running on port ${PORT}`
  );
});
