require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

/*
============================================================
CONFIGURATION
============================================================
*/

const {
  INTUIT_CLIENT_ID,
  INTUIT_CLIENT_SECRET,
  INTUIT_REDIRECT_URI,
  DATABASE_URL
} = process.env;

app.use(cors());
app.use(express.json());

/*
============================================================
DATABASE
============================================================
*/

if (!DATABASE_URL) {
  console.error("DATABASE_URL is missing.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  max: 5
});

/*
============================================================
DATABASE INITIALIZATION
============================================================
*/

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS quickbooks_connection (
      id INTEGER PRIMARY KEY,
      realm_id TEXT NOT NULL,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      access_token_expires_at TIMESTAMPTZ,
      refresh_token_expires_at TIMESTAMPTZ,
      connected_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  console.log("PostgreSQL database initialized.");
}

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
console.log(
  "DATABASE_URL:",
  DATABASE_URL ? "SET" : "MISSING"
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

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      status: "healthy",
      database: "connected",
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error("Health check database error:", error.message);

    res.status(500).json({
      status: "unhealthy",
      database: "disconnected",
      timestamp: new Date().toISOString()
    });
  }
});

/*
============================================================
INTUIT CONFIGURATION DIAGNOSTIC
============================================================
*/

app.get("/debug/intuit", (req, res) => {
  res.json({
    client_id_present: !!INTUIT_CLIENT_ID,
    client_secret_present: !!INTUIT_CLIENT_SECRET,
    redirect_uri: INTUIT_REDIRECT_URI || null,
    redirect_uri_length: INTUIT_REDIRECT_URI
      ? INTUIT_REDIRECT_URI.length
      : null,
    database_url_present: !!DATABASE_URL
  });
});

/*
============================================================
QUICKBOOKS CONNECTION STATUS
============================================================
*/

app.get("/quickbooks/status", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        realm_id,
        connected_at,
        updated_at,
        access_token_expires_at,
        refresh_token_expires_at
      FROM quickbooks_connection
      WHERE id = 1
      LIMIT 1
    `);

    if (result.rows.length === 0) {
      return res.json({
        connected: false,
        message: "QuickBooks is not connected."
      });
    }

    const connection = result.rows[0];

    res.json({
      connected: true,
      realmId: connection.realm_id,
      connected_at: connection.connected_at,
      updated_at: connection.updated_at,
      access_token_expires_at:
        connection.access_token_expires_at,
      refresh_token_expires_at:
        connection.refresh_token_expires_at
    });

  } catch (error) {
    console.error(
      "QuickBooks status error:",
      error.message
    );

    res.status(500).json({
      connected: false,
      error: "Unable to check QuickBooks connection."
    });
  }
});

/*
============================================================
START QUICKBOOKS AUTHORIZATION
============================================================
*/

app.get("/auth/intuit", async (req, res) => {
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

  try {
    /*
    Generate a state value and store it in PostgreSQL.
    This protects the OAuth flow from CSRF attacks.
    */

    const state = require("crypto")
      .randomBytes(32)
      .toString("hex");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS oauth_state (
        id INTEGER PRIMARY KEY,
        state TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await pool.query(
      `
      INSERT INTO oauth_state (id, state, created_at)
      VALUES (1, $1, NOW())
      ON CONFLICT (id)
      DO UPDATE SET
        state = EXCLUDED.state,
        created_at = NOW()
      `,
      [state]
    );

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
    console.log("Starting QuickBooks OAuth");
    console.log(
      "Redirect URI:",
      INTUIT_REDIRECT_URI
    );
    console.log("========================================");

    res.redirect(authUrl);

  } catch (error) {
    console.error(
      "OAuth start error:",
      error.message
    );

    res.status(500).send(
      "Unable to start QuickBooks authorization."
    );
  }
});

/*
============================================================
QUICKBOOKS OAUTH CALLBACK
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
    console.error("Intuit OAuth error");
    console.error("Error:", error);
    console.error(
      "Description:",
      error_description || "None"
    );
    console.error("========================================");

    return res.status(400).json({
      success: false,
      error: error,
      error_description:
        error_description || null
    });
  }

  /*
  Require authorization code
  */

  if (!code) {
    return res.status(400).json({
      success: false,
      error: "Authorization code missing."
    });
  }

  /*
  Require realm ID
  */

  if (!realmId) {
    return res.status(400).json({
      success: false,
      error: "QuickBooks company realm ID missing."
    });
  }

  /*
  Validate OAuth state
  */

  try {
    const stateResult = await pool.query(
      `
      SELECT state
      FROM oauth_state
      WHERE id = 1
      LIMIT 1
      `
    );

    if (
      stateResult.rows.length === 0 ||
      stateResult.rows[0].state !== state
    ) {
      return res.status(400).json({
        success: false,
        error: "Invalid OAuth state."
      });
    }

    /*
    Delete used state.
    */

    await pool.query(
      "DELETE FROM oauth_state WHERE id = 1"
    );

  } catch (error) {
    console.error(
      "OAuth state validation error:",
      error.message
    );

    return res.status(500).json({
      success: false,
      error: "Unable to validate OAuth state."
    });
  }

  /*
  Check environment
  */

  if (
    !INTUIT_CLIENT_ID ||
    !INTUIT_CLIENT_SECRET ||
    !INTUIT_REDIRECT_URI
  ) {
    return res.status(500).json({
      success: false,
      error:
        "Intuit credentials are missing from server environment."
    });
  }

  /*
  Exchange authorization code for tokens
  */

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
    Calculate token expiration times.
    */

    const accessTokenExpiresAt =
      tokenData.expires_in
        ? new Date(
            Date.now() +
            tokenData.expires_in * 1000
          )
        : null;

    const refreshTokenExpiresAt =
      tokenData.x_refresh_token_expires_in
        ? new Date(
            Date.now() +
            tokenData.x_refresh_token_expires_in * 1000
          )
        : null;

    /*
    Save QuickBooks connection to PostgreSQL.
    */

    await pool.query(
      `
      INSERT INTO quickbooks_connection (
        id,
        realm_id,
        access_token,
        refresh_token,
        access_token_expires_at,
        refresh_token_expires_at,
        connected_at,
        updated_at
      )
      VALUES (
        1,
        $1,
        $2,
        $3,
        $4,
        $5,
        NOW(),
        NOW()
      )

      ON CONFLICT (id)
      DO UPDATE SET
        realm_id = EXCLUDED.realm_id,
        access_token = EXCLUDED.access_token,
        refresh_token = EXCLUDED.refresh_token,
        access_token_expires_at =
          EXCLUDED.access_token_expires_at,
        refresh_token_expires_at =
          EXCLUDED.refresh_token_expires_at,
        updated_at = NOW()
      `,

      [
        realmId,
        tokenData.access_token,
        tokenData.refresh_token,
        accessTokenExpiresAt,
        refreshTokenExpiresAt
      ]
    );

    console.log("========================================");
    console.log("QuickBooks OAuth successful");
    console.log("Realm ID:", realmId);
    console.log(
      "Access token saved:",
      !!tokenData.access_token
    );
    console.log(
      "Refresh token saved:",
      !!tokenData.refresh_token
    );
    console.log("========================================");

    res.json({
      success: true,
      message:
        "QuickBooks connected and securely saved.",
      realmId: realmId,
      access_token_saved:
        !!tokenData.access_token,
      refresh_token_saved:
        !!tokenData.refresh_token
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
GET SAVED QUICKBOOKS CONNECTION
============================================================
*/

async function getQuickBooksConnection() {
  const result = await pool.query(`
    SELECT *
    FROM quickbooks_connection
    WHERE id = 1
    LIMIT 1
  `);

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0];
}

/*
============================================================
REFRESH QUICKBOOKS ACCESS TOKEN
============================================================
*/

async function refreshQuickBooksToken(connection) {
  if (!connection) {
    throw new Error(
      "QuickBooks is not connected."
    );
  }

  const response = await axios.post(
    "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",

    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: connection.refresh_token
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

  const accessTokenExpiresAt =
    tokenData.expires_in
      ? new Date(
          Date.now() +
          tokenData.expires_in * 1000
        )
      : null;

  /*
  Intuit may return a new refresh token.
  If it doesn't, keep the existing one.
  */

  const refreshToken =
    tokenData.refresh_token ||
    connection.refresh_token;

  const refreshTokenExpiresAt =
    tokenData.x_refresh_token_expires_in
      ? new Date(
          Date.now() +
          tokenData.x_refresh_token_expires_in * 1000
        )
      : connection.refresh_token_expires_at;

  await pool.query(
    `
    UPDATE quickbooks_connection
    SET
      access_token = $1,
      refresh_token = $2,
      access_token_expires_at = $3,
      refresh_token_expires_at = $4,
      updated_at = NOW()
    WHERE id = 1
    `,
    [
      tokenData.access_token,
      refreshToken,
      accessTokenExpiresAt,
      refreshTokenExpiresAt
    ]
  );

  console.log(
    "QuickBooks access token refreshed."
  );

  return {
    ...connection,
    access_token: tokenData.access_token,
    refresh_token: refreshToken,
    access_token_expires_at:
      accessTokenExpiresAt,
    refresh_token_expires_at:
      refreshTokenExpiresAt
  };
}

/*
============================================================
GET A VALID QUICKBOOKS ACCESS TOKEN
============================================================
*/

async function getValidAccessToken() {
  let connection =
    await getQuickBooksConnection();

  if (!connection) {
    throw new Error(
      "QuickBooks is not connected. Authorize QuickBooks first."
    );
  }

  /*
  Refresh if the access token expires within
  the next five minutes.
  */

  const expiresAt =
    connection.access_token_expires_at
      ? new Date(
          connection.access_token_expires_at
        ).getTime()
      : 0;

  const fiveMinutes =
    5 * 60 * 1000;

  if (
    !expiresAt ||
    expiresAt <= Date.now() + fiveMinutes
  ) {
    connection =
      await refreshQuickBooksToken(
        connection
      );
  }

  return connection.access_token;
}

/*
============================================================
QUICKBOOKS COMPANY INFORMATION
============================================================
*/

app.get(
  "/quickbooks/company",
  async (req, res) => {
    try {
      const connection =
        await getQuickBooksConnection();

      if (!connection) {
        return res.status(400).json({
          success: false,
          error:
            "QuickBooks is not connected. Authorize QuickBooks first."
        });
      }

      const accessToken =
        await getValidAccessToken();

      const companyResponse =
        await axios.get(
          `https://quickbooks.api.intuit.com/v3/company/${connection.realm_id}/companyinfo/${connection.realm_id}`,
          {
            headers: {
              Authorization:
                `Bearer ${accessToken}`,

              Accept:
                "application/json"
            }
          }
        );

      const company =
        companyResponse.data
          ?.CompanyInfo;

      res.json({
        success: true,
        message:
          "Successfully connected to QuickBooks.",
        company: company || null
      });

    } catch (error) {
      console.error(
        "QuickBooks company error:",
        error.response?.data ||
        error.message
      );

      res.status(500).json({
        success: false,
        error:
          "Unable to retrieve QuickBooks company information."
      });
    }
  }
);

/*
============================================================
QUICKBOOKS API TEST
============================================================
*/

app.get(
  "/quickbooks/test",
  async (req, res) => {
    try {
      const connection =
        await getQuickBooksConnection();

      if (!connection) {
        return res.status(400).json({
          success: false,
          connected: false,
          error:
            "QuickBooks is not connected."
        });
      }

      const accessToken =
        await getValidAccessToken();

      /*
      Query the company information endpoint
      as a live API connection test.
      */

      const response =
        await axios.get(
          `https://quickbooks.api.intuit.com/v3/company/${connection.realm_id}/companyinfo/${connection.realm_id}`,
          {
            headers: {
              Authorization:
                `Bearer ${accessToken}`,

              Accept:
                "application/json"
            }
          }
        );

      res.json({
        success: true,
        connected: true,
        realmId:
          connection.realm_id,
        api_working: true,
        company_name:
          response.data?.CompanyInfo
            ?.CompanyName || null
      });

    } catch (error) {
      console.error(
        "QuickBooks API test error:",
        error.response?.data ||
        error.message
      );

      res.status(500).json({
        success: false,
        connected: false,
        api_working: false,
        error:
          "QuickBooks API test failed."
      });
    }
  }
);

/*
============================================================
START SERVER
============================================================
*/

async function startServer() {
  try {
    await initializeDatabase();

    app.listen(PORT, () => {
      console.log(
        `Lesik Receipt Automation backend running on port ${PORT}`
      );
    });

  } catch (error) {
    console.error(
      "Unable to start application:",
      error
    );

    process.exit(1);
  }
}

startServer();
