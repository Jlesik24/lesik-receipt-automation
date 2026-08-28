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

/*
============================================================
ENVIRONMENT VALIDATION
============================================================
*/

console.log("========================================");
console.log("Lesik Receipt Automation");
console.log("Environment configuration:");
console.log("INTUIT_CLIENT_ID:", INTUIT_CLIENT_ID ? "SET" : "MISSING");
console.log(
  "INTUIT_CLIENT_SECRET:",
  INTUIT_CLIENT_SECRET ? "SET" : "MISSING"
);
console.log(
  "INTUIT_REDIRECT_URI:",
  INTUIT_REDIRECT_URI || "MISSING"
);
console.log("========================================");

/*
============================================================
HOME / STATUS
============================================================
*/

app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: "Lesik Receipt Automation",
    version: "1.0.0"
  });
});

/*
============================================================
HEALTH CHECK
============================================================
*/

app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString()
  });
});

/*
============================================================
INTUIT ENVIRONMENT DIAGNOSTIC
============================================================
*/

app.get("/debug/intuit", (req, res) => {
  res.json({
    client_id_present: !!INTUIT_CLIENT_ID,
    client_secret_present: !!INTUIT_CLIENT_SECRET,
    redirect_uri: INTUIT_REDIRECT_URI || null,
    redirect_uri_length: INTUIT_REDIRECT_URI
      ? INTUIT_REDIRECT_URI.length
      : null
  });
});

/*
============================================================
INTUIT OAUTH URL DIAGNOSTIC
============================================================
*/

app.get("/debug/intuit-url", (req, res) => {
  if (!INTUIT_CLIENT_ID) {
    return res.status(500).json({
      error: "INTUIT_CLIENT_ID is missing."
    });
  }

  if (!INTUIT_REDIRECT_URI) {
    return res.status(500).json({
      error: "INTUIT_REDIRECT_URI is missing."
    });
  }

  const state = "diagnostic-test";

  const authParams = new URLSearchParams({
    client_id: INTUIT_CLIENT_ID,
    response_type: "code",
    scope: "com.intuit.quickbooks.accounting",
    redirect_uri: INTUIT_REDIRECT_URI,
    state: state
  });

  const authUrl =
    "https://appcenter.intuit.com/connect/oauth2?" +
    authParams.toString();

  res.json({
    redirect_uri_from_environment: INTUIT_REDIRECT_URI,
    redirect_uri_length: INTUIT_REDIRECT_URI.length,
    generated_oauth_url: authUrl
  });
});

/*
============================================================
START QUICKBOOKS / INTUIT AUTHORIZATION
============================================================
*/

app.get("/auth/intuit", (req, res) => {
  if (!INTUIT_CLIENT_ID) {
    return res.status(500).send(
      "INTUIT_CLIENT_ID is missing from the server environment."
    );
  }

  if (!INTUIT_CLIENT_SECRET) {
    return res.status(500).send(
      "INTUIT_CLIENT_SECRET is missing from the server environment."
    );
  }

  if (!INTUIT_REDIRECT_URI) {
    return res.status(500).send(
      "INTUIT_REDIRECT_URI is missing from the server environment."
    );
  }

  const state = Math.random().toString(36).substring(2);

  const authParams = new URLSearchParams({
    client_id: INTUIT_CLIENT_ID,
    response_type: "code",
    scope: "com.intuit.quickbooks.accounting",
    redirect_uri: INTUIT_REDIRECT_URI,
    state: state
  });

  const authUrl =
    "https://appcenter.intuit.com/connect/oauth2?" +
    authParams.toString();

  console.log("========================================");
  console.log("Starting Intuit OAuth");
  console.log("Redirect URI being sent to Intuit:");
  console.log(INTUIT_REDIRECT_URI);
  console.log("========================================");

  res.redirect(authUrl);
});

/*
============================================================
QUICKBOOKS / INTUIT OAUTH CALLBACK
============================================================
*/

app.get("/auth/intuit/callback", async (req, res) => {
  const {
    code,
    realmId,
    state,
    error,
    error_description
  } = req.query;

  /*
  Handle an error returned by Intuit
  */

  if (error) {
    console.error("========================================");
    console.error("Intuit OAuth returned an error");
    console.error("Error:", error);
    console.error(
      "Description:",
      error_description || "None"
    );
    console.error("========================================");

    return res.status(400).json({
      success: false,
      error: error,
      error_description: error_description || null
    });
  }

  /*
  Make sure we received an authorization code
  */

  if (!code) {
    return res.status(400).json({
      success: false,
      error: "Authorization code missing."
    });
  }

  /*
  Make sure required environment variables exist
  */

  if (!INTUIT_CLIENT_ID || !INTUIT_CLIENT_SECRET) {
    return res.status(500).json({
      success: false,
      error:
        "Intuit client credentials are missing from server environment."
    });
  }

  if (!INTUIT_REDIRECT_URI) {
    return res.status(500).json({
      success: false,
      error:
        "INTUIT_REDIRECT_URI is missing from server environment."
    });
  }

  try {
    /*
    Exchange authorization code for tokens
    */

    const tokenResponse = await axios.post(
      "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
      new URLSearchParams({
        grant_type: "authorization_code",
        code: code,
        redirect_uri: INTUIT_REDIRECT_URI
      }).toString(),
      {
        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded",
          "Authorization":
            "Basic " +
            Buffer.from(
              INTUIT_CLIENT_ID +
              ":" +
              INTUIT_CLIENT_SECRET
            ).toString("base64")
        }
      }
    );

    console.log("========================================");
    console.log("QuickBooks OAuth successful");
    console.log("Realm ID:", realmId);
    console.log(
      "Access token received:",
      !!tokenResponse.data.access_token
    );
    console.log(
      "Refresh token received:",
      !!tokenResponse.data.refresh_token
    );
    console.log("========================================");

    /*
    IMPORTANT:
    Never display the actual tokens.
    */

    res.json({
      success: true,
      message:
        "QuickBooks connected successfully.",
      realmId: realmId || null,
      access_token_received:
        !!tokenResponse.data.access_token,
      refresh_token_received:
        !!tokenResponse.data.refresh_token
    });

  } catch (error) {
    console.error("========================================");
    console.error("QuickBooks OAuth error");

    if (error.response) {
      console.error(
        "Status:",
        error.response.status
      );

      console.error(
        "Response:",
        error.response.data
      );
    } else {
      console.error(
        "Message:",
        error.message
      );
    }

    console.error("========================================");

    res.status(500).json({
      success: false,
      error:
        "QuickBooks authorization failed."
    });
  }
});

/*
============================================================
START SERVER
============================================================
*/

app.listen(PORT, () => {
  console.log(
    `Lesik Receipt Automation backend running on port ${PORT}`
  );
});
