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
CONFIGURATION
============================================================
*/

const INTUIT_TOKEN_URL =
  "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

const INTUIT_API_BASE =
  "https://quickbooks.api.intuit.com";

/*
============================================================
TEMPORARY TOKEN STORAGE
============================================================

IMPORTANT:
This is temporary development storage.

Tokens will be moved to persistent encrypted storage
before the system is considered production-ready.

============================================================
*/

let quickbooksConnection = {
  connected: false,
  realmId: null,
  accessToken: null,
  refreshToken: null,
  accessTokenExpiresAt: null,
  connectedAt: null
};

/*
============================================================
ENVIRONMENT VALIDATION
============================================================
*/

console.log("========================================");
console.log("Lesik Receipt Automation");
console.log("Environment configuration:");
console.log(
  "INTUIT_CLIENT_ID:",
  INTUIT_CLIENT_ID ? "SET" : "MISSING"
);
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
HELPER - CHECK INTUIT CONFIGURATION
============================================================
*/

function validateIntuitConfiguration() {
  if (!INTUIT_CLIENT_ID) {
    return "INTUIT_CLIENT_ID is missing.";
  }

  if (!INTUIT_CLIENT_SECRET) {
    return "INTUIT_CLIENT_SECRET is missing.";
  }

  if (!INTUIT_REDIRECT_URI) {
    return "INTUIT_REDIRECT_URI is missing.";
  }

  return null;
}

/*
============================================================
HOME / STATUS
============================================================
*/

app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: "Lesik Receipt Automation",
    version: "1.1.0"
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
INTUIT CONFIGURATION DEBUG
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
INTUIT GENERATED OAUTH URL DEBUG
============================================================
*/

app.get("/debug/intuit-url", (req, res) => {
  const configError = validateIntuitConfiguration();

  if (configError) {
    return res.status(500).json({
      success: false,
      error: configError
    });
  }

  const authParams = new URLSearchParams({
    client_id: INTUIT_CLIENT_ID,
    response_type: "code",
    scope: "com.intuit.quickbooks.accounting",
    redirect_uri: INTUIT_REDIRECT_URI,
    state: "diagnostic-test"
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
  const configError = validateIntuitConfiguration();

  if (configError) {
    return res.status(500).send(configError);
  }

  const state =
    Math.random().toString(36).substring(2) +
    Date.now().toString(36);

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
  console.log("Redirect URI:");
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
  Handle Intuit OAuth errors
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
  Authorization code required
  */

  if (!code) {
    return res.status(400).json({
      success: false,
      error: "Authorization code missing."
    });
  }

  /*
  Validate configuration
  */

  const configError = validateIntuitConfiguration();

  if (configError) {
    return res.status(500).json({
      success: false,
      error: configError
    });
  }

  try {
    /*
    Exchange authorization code for tokens
    */

    const tokenResponse = await axios.post(
      INTUIT_TOKEN_URL,
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

    const tokenData = tokenResponse.data;

    /*
    Calculate access token expiration
    */

    const expiresIn =
      Number(tokenData.expires_in) || 3600;

    const accessTokenExpiresAt =
      Date.now() + expiresIn * 1000;

    /*
    Store connection information
    */

    quickbooksConnection = {
      connected: true,
      realmId: realmId || null,
      accessToken:
        tokenData.access_token || null,
      refreshToken:
        tokenData.refresh_token || null,
      accessTokenExpiresAt:
        accessTokenExpiresAt,
      connectedAt:
        new Date().toISOString()
    };

    console.log("========================================");
    console.log("QuickBooks OAuth successful");
    console.log("Realm ID:", realmId || "MISSING");
    console.log(
      "Access token received:",
      !!tokenData.access_token
    );
    console.log(
      "Refresh token received:",
      !!tokenData.refresh_token
    );
    console.log(
      "Access token expires:",
      new Date(accessTokenExpiresAt).toISOString()
    );
    console.log("========================================");

    /*
    Never display actual token values
    */

    res.json({
      success: true,
      message:
        "QuickBooks connected successfully.",
      realmId: realmId || null,
      access_token_received:
        !!tokenData.access_token,
      refresh_token_received:
        !!tokenData.refresh_token,
      access_token_expires_at:
        new Date(
          accessTokenExpiresAt
        ).toISOString()
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

    return res.status(500).json({
      success: false,
      error:
        "QuickBooks authorization failed."
    });
  }
});

/*
============================================================
REFRESH QUICKBOOKS ACCESS TOKEN
============================================================
*/

async function refreshQuickBooksToken() {

  if (!quickbooksConnection.refreshToken) {
    throw new Error(
      "No QuickBooks refresh token is available."
    );
  }

  const configError =
    validateIntuitConfiguration();

  if (configError) {
    throw new Error(configError);
  }

  console.log(
    "Refreshing QuickBooks access token..."
  );

  try {

    const response = await axios.post(
      INTUIT_TOKEN_URL,
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token:
          quickbooksConnection.refreshToken
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

    const tokenData = response.data;

    const expiresIn =
      Number(tokenData.expires_in) || 3600;

    quickbooksConnection.accessToken =
      tokenData.access_token;

    /*
    Intuit can rotate the refresh token.
    If a new refresh token is returned,
    save the new one.
    */

    if (tokenData.refresh_token) {
      quickbooksConnection.refreshToken =
        tokenData.refresh_token;
    }

    quickbooksConnection.accessTokenExpiresAt =
      Date.now() + expiresIn * 1000;

    quickbooksConnection.connected =
      true;

    console.log(
      "QuickBooks access token refreshed successfully."
    );

    return quickbooksConnection.accessToken;

  } catch (error) {

    console.error(
      "QuickBooks token refresh failed:"
    );

    if (error.response) {
      console.error(
        error.response.status
      );

      console.error(
        error.response.data
      );
    } else {
      console.error(error.message);
    }

    quickbooksConnection.connected =
      false;

    throw error;
  }
}

/*
============================================================
GET VALID QUICKBOOKS ACCESS TOKEN
============================================================
*/

async function getQuickBooksAccessToken() {

  if (
    !quickbooksConnection.accessToken ||
    !quickbooksConnection.refreshToken
  ) {
    throw new Error(
      "QuickBooks is not connected. Authorize QuickBooks first."
    );
  }

  /*
  Refresh five minutes before expiration.
  */

  const refreshBuffer =
    5 * 60 * 1000;

  const tokenNeedsRefresh =
    !quickbooksConnection.accessTokenExpiresAt ||
    Date.now() >=
      quickbooksConnection.accessTokenExpiresAt -
        refreshBuffer;

  if (tokenNeedsRefresh) {
    return await refreshQuickBooksToken();
  }

  return quickbooksConnection.accessToken;
}

/*
============================================================
QUICKBOOKS CONNECTION STATUS
============================================================
*/

app.get(
  "/quickbooks/status",
  (req, res) => {

    res.json({
      connected:
        quickbooksConnection.connected,

      realmId:
        quickbooksConnection.realmId,

      access_token_available:
        !!quickbooksConnection.accessToken,

      refresh_token_available:
        !!quickbooksConnection.refreshToken,

      access_token_expires_at:
        quickbooksConnection.accessTokenExpiresAt
          ? new Date(
              quickbooksConnection.accessTokenExpiresAt
            ).toISOString()
          : null,

      connected_at:
        quickbooksConnection.connectedAt
    });
  }
);

/*
============================================================
QUICKBOOKS COMPANY TEST
============================================================

This makes a REAL API request to QuickBooks.

============================================================
*/

app.get(
  "/quickbooks/company",
  async (req, res) => {

    if (!quickbooksConnection.realmId) {
      return res.status(400).json({
        success: false,
        error:
          "QuickBooks is not connected. Authorize QuickBooks first."
      });
    }

    try {

      const accessToken =
        await getQuickBooksAccessToken();

      const realmId =
        quickbooksConnection.realmId;

      const response =
        await axios.get(
          `${INTUIT_API_BASE}/v3/company/${realmId}/companyinfo/${realmId}`,
          {
            headers: {
              Authorization:
                `Bearer ${accessToken}`,

              Accept:
                "application/json"
            }
          }
        );

      const companyInfo =
        response.data?.QueryResponse?.CompanyInfo?.[0];

      res.json({
        success: true,
        message:
          "Successfully connected to QuickBooks.",
        company: companyInfo || null
      });

    } catch (error) {

      console.error(
        "QuickBooks company API error:"
      );

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

      res.status(
        error.response?.status || 500
      ).json({
        success: false,
        error:
          "Unable to retrieve QuickBooks company information.",
        details:
          error.response?.data || null
      });
    }
  }
);

/*
============================================================
MANUAL TOKEN REFRESH TEST
============================================================
*/

app.post(
  "/quickbooks/refresh",
  async (req, res) => {

    try {

      await refreshQuickBooksToken();

      res.json({
        success: true,
        message:
          "QuickBooks access token refreshed successfully.",
        access_token_available:
          !!quickbooksConnection.accessToken,
        refresh_token_available:
          !!quickbooksConnection.refreshToken,
        access_token_expires_at:
          quickbooksConnection.accessTokenExpiresAt
            ? new Date(
                quickbooksConnection.accessTokenExpiresAt
              ).toISOString()
            : null
      });

    } catch (error) {

      res.status(500).json({
        success: false,
        error:
          "QuickBooks token refresh failed."
      });
    }
  }
);

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
