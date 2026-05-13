const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const { sql, pool, poolConnect } = require("../config/db");
const { verifyToken } = require("../middleware/authMiddleware");
const jwt = require("jsonwebtoken");

// ================================================
// WebAuthn / FIDO2 биометрия (Passkey) маршруттары
// Кітапхана: @simplewebauthn/server (npm install @simplewebauthn/server)
// ================================================

let SimpleWebAuthn;
try {
  SimpleWebAuthn = require("@simplewebauthn/server");
} catch {
  console.warn("@simplewebauthn/server орнатылмаған. npm install @simplewebauthn/server");
}

const RP_NAME = "AuthGuard Locker";
const configuredFrontendOrigins = (process.env.FRONTEND_URL || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const getOrigin = (req) =>
  req.get("origin") ||
  configuredFrontendOrigins.find((origin) => origin.startsWith("https://")) ||
  configuredFrontendOrigins[0] ||
  `https://${req.hostname}`;
const getRpId = (req) => {
  if (process.env.RP_ID) return process.env.RP_ID;

  try {
    return new URL(getOrigin(req)).hostname;
  } catch {
    return req.hostname || "localhost";
  }
};

// ─── Уақытша challenge сақтау (production-да Redis қолданыңыз) ───
const challengeStore = new Map();
const setChallengeForUser = (userId, challenge) => {
  challengeStore.set(`reg_${userId}`, { challenge, ts: Date.now() });
};
const getChallengeForUser = (userId) => {
  const entry = challengeStore.get(`reg_${userId}`);
  if (!entry) return null;
  if (Date.now() - entry.ts > 5 * 60 * 1000) {
    challengeStore.delete(`reg_${userId}`);
    return null;
  }
  return entry.challenge;
};
const setAuthChallenge = (key, challenge) => {
  challengeStore.set(`auth_${key}`, { challenge, ts: Date.now() });
};
const getAuthChallenge = (key) => {
  const entry = challengeStore.get(`auth_${key}`);
  if (!entry) return null;
  if (Date.now() - entry.ts > 5 * 60 * 1000) {
    challengeStore.delete(`auth_${key}`);
    return null;
  }
  return entry.challenge;
};

const isBiometricAvailable = () => Boolean(SimpleWebAuthn);

router.get("/status", (req, res) => {
  res.json({
    available: isBiometricAvailable(),
    rpId: process.env.RP_ID || null,
  });
});

// ──────────────────────────────────────────────────
// 1. ТІРКЕУ — Registration options
// POST /api/biometric/register/options
// ──────────────────────────────────────────────────
router.post("/register/options", verifyToken, async (req, res) => {
  if (!SimpleWebAuthn) {
    return res.status(501).json({ message: "@simplewebauthn/server орнатылмаған" });
  }

  try {
    await poolConnect;
    const userId = req.user.id;

    // Пайдаланушы деректерін алу
    const userResult = await pool
      .request()
      .input("userId", sql.Int, userId)
      .query("SELECT TOP 1 id, email, full_name FROM users WHERE id = @userId");

    const user = userResult.recordset[0];
    if (!user) return res.status(404).json({ message: "Пайдаланушы табылмады" });

    // Бұрын тіркелген credential ID-лерді алу
    const existingResult = await pool
      .request()
      .input("userId", sql.Int, userId)
      .query("SELECT credential_id FROM biometric_credentials WHERE user_id = @userId");

    const excludeCredentials = existingResult.recordset.map((row) => ({
      id: row.credential_id,
      type: "public-key",
    }));

    const options = await SimpleWebAuthn.generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: getRpId(req),
      userID: Buffer.from(String(user.id)),
      userName: user.email,
      userDisplayName: user.full_name || user.email,
      attestationType: "none",
      excludeCredentials,
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "preferred",
      },
    });

    setChallengeForUser(userId, options.challenge);

    res.json(options);
  } catch (error) {
    console.error("BIOMETRIC REGISTER OPTIONS ERROR:", error);
    res.status(500).json({ message: "Биометрия опцияларын жасау қатесі" });
  }
});

// ──────────────────────────────────────────────────
// 2. ТІРКЕУ — Registration verify
// POST /api/biometric/register/verify
// ──────────────────────────────────────────────────
router.post("/register/verify", verifyToken, async (req, res) => {
  if (!SimpleWebAuthn) {
    return res.status(501).json({ message: "@simplewebauthn/server орнатылмаған" });
  }

  try {
    const userId = req.user.id;
    const { credential, deviceName } = req.body;

    const expectedChallenge = getChallengeForUser(userId);
    if (!expectedChallenge) {
      return res.status(400).json({ message: "Challenge жоқ немесе мерзімі өтті" });
    }

    const verification = await SimpleWebAuthn.verifyRegistrationResponse({
      response: credential,
      expectedChallenge,
      expectedOrigin: getOrigin(req),
      expectedRPID: getRpId(req),
    });

    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ message: "Биометрия расталмады" });
    }

    const { credential: cred, aaguid } = verification.registrationInfo;

    await poolConnect;

    // Дерекқорға сақтау
    await pool
      .request()
      .input("userId", sql.Int, userId)
      .input("credentialId", sql.NVarChar(500), cred.id)
      .input("publicKey", sql.NVarChar(sql.MAX), Buffer.from(cred.publicKey).toString("base64"))
      .input("signCount", sql.BigInt, cred.counter)
      .input("deviceName", sql.NVarChar(255), deviceName || "Менің құрылғым")
      .input("aaguid", sql.NVarChar(255), aaguid || "")
      .query(`
        INSERT INTO biometric_credentials
          (user_id, credential_id, public_key, sign_count, device_name, aaguid, created_at, last_used_at)
        VALUES
          (@userId, @credentialId, @publicKey, @signCount, @deviceName, @aaguid, GETDATE(), GETDATE())
      `);

    // Лог
    await pool
      .request()
      .input("userId", sql.Int, userId)
      .input("action", sql.NVarChar(100), "BIOMETRIC_REGISTER")
      .input("details", sql.NVarChar(sql.MAX), `Биометрия тіркелді: ${deviceName || "Менің құрылғым"}`)
      .query(`
        INSERT INTO activity_logs (user_id, action_type, action_details, created_at)
        VALUES (@userId, @action, @details, GETDATE())
      `);

    res.json({ verified: true, message: "Биометрия сәтті тіркелді" });
  } catch (error) {
    console.error("BIOMETRIC REGISTER VERIFY ERROR:", error);
    res.status(500).json({ message: "Биометрия тіркеу расталмады" });
  }
});

// ──────────────────────────────────────────────────
// 3. КІРУoptionser — Authentication options (email арқылы)
// POST /api/biometric/login/options
// Body: { email }
// ──────────────────────────────────────────────────
router.post("/login/options", async (req, res) => {
  if (!SimpleWebAuthn) {
    return res.status(501).json({ message: "@simplewebauthn/server орнатылмаған" });
  }

  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: "Email міндетті" });

    await poolConnect;

    const userResult = await pool
      .request()
      .input("email", sql.NVarChar(255), email.trim().toLowerCase())
      .input("isVerified", sql.Bit, true)
      .query("SELECT TOP 1 id FROM users WHERE email = @email AND is_verified = @isVerified");

    const user = userResult.recordset[0];
    if (!user) {
      return res.status(404).json({ message: "Пайдаланушы табылмады" });
    }

    const credsResult = await pool
      .request()
      .input("userId", sql.Int, user.id)
      .query("SELECT credential_id FROM biometric_credentials WHERE user_id = @userId");

    if (credsResult.recordset.length === 0) {
      return res.status(400).json({ message: "Бұл аккаунтта биометрия тіркелмеген" });
    }

    const allowCredentials = credsResult.recordset.map((row) => ({
      id: row.credential_id,
      type: "public-key",
    }));

    const options = await SimpleWebAuthn.generateAuthenticationOptions({
      rpID: getRpId(req),
      allowCredentials,
      userVerification: "preferred",
    });

    setAuthChallenge(`user_${user.id}`, options.challenge);

    res.json({ ...options, userId: user.id });
  } catch (error) {
    console.error("BIOMETRIC LOGIN OPTIONS ERROR:", error);
    res.status(500).json({ message: "Биометрия кіру опциясы қатесі" });
  }
});

// ──────────────────────────────────────────────────
// 4. КІРУ — Authentication verify
// POST /api/biometric/login/verify
// Body: { userId, credential }
// ──────────────────────────────────────────────────
router.post("/login/verify", async (req, res) => {
  if (!SimpleWebAuthn) {
    return res.status(501).json({ message: "@simplewebauthn/server орнатылмаған" });
  }

  try {
    const { userId, credential } = req.body;
    if (!userId || !credential) {
      return res.status(400).json({ message: "userId және credential міндетті" });
    }

    const expectedChallenge = getAuthChallenge(`user_${userId}`);
    if (!expectedChallenge) {
      return res.status(400).json({ message: "Challenge жоқ немесе мерзімі өтті" });
    }

    await poolConnect;

    const credId = credential.id;
    const credResult = await pool
      .request()
      .input("userId", sql.Int, userId)
      .input("credentialId", sql.NVarChar(500), credId)
      .query(`
        SELECT TOP 1 * FROM biometric_credentials
        WHERE user_id = @userId AND credential_id = @credentialId
      `);

    const storedCred = credResult.recordset[0];
    if (!storedCred) {
      return res.status(400).json({ message: "Credential табылмады" });
    }

    const verification = await SimpleWebAuthn.verifyAuthenticationResponse({
      response: credential,
      expectedChallenge,
      expectedOrigin: getOrigin(req),
      expectedRPID: getRpId(req),
      credential: {
        id: storedCred.credential_id,
        publicKey: Buffer.from(storedCred.public_key, "base64"),
        counter: Number(storedCred.sign_count),
      },
    });

    if (!verification.verified) {
      return res.status(400).json({ message: "Биометрия расталмады" });
    }

    // sign_count жаңарту (replay attack болдырмау)
    await pool
      .request()
      .input("newCount", sql.BigInt, verification.authenticationInfo.newCounter)
      .input("credentialId", sql.NVarChar(500), credId)
      .query(`
        UPDATE biometric_credentials
        SET sign_count = @newCount, last_used_at = GETDATE()
        WHERE credential_id = @credentialId
      `);

    // Пайдаланушы деректерін алу
    const userResult = await pool
      .request()
      .input("userId", sql.Int, userId)
      .query("SELECT TOP 1 id, email, full_name, role, twofa_enabled FROM users WHERE id = @userId");

    const user = userResult.recordset[0];

    // JWT токен жасау
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, type: "access" },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    // Лог
    await pool
      .request()
      .input("userId", sql.Int, userId)
      .input("action", sql.NVarChar(100), "BIOMETRIC_LOGIN")
      .input("details", sql.NVarChar(sql.MAX), `Биометрия арқылы кіру: ${user.email}`)
      .query(`
        INSERT INTO activity_logs (user_id, action_type, action_details, created_at)
        VALUES (@userId, @action, @details, GETDATE())
      `);

    res.json({
      verified: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
        twofa_enabled: user.twofa_enabled,
      },
    });
  } catch (error) {
    console.error("BIOMETRIC LOGIN VERIFY ERROR:", error);
    res.status(500).json({ message: "Биометрия расталмады" });
  }
});

// ──────────────────────────────────────────────────
// 5. Тіркелген биометрия тізімі
// GET /api/biometric/list
// ──────────────────────────────────────────────────
router.get("/list", verifyToken, async (req, res) => {
  try {
    await poolConnect;

    const result = await pool
      .request()
      .input("userId", sql.Int, req.user.id)
      .query(`
        SELECT id, device_name, aaguid, created_at, last_used_at
        FROM biometric_credentials
        WHERE user_id = @userId
        ORDER BY created_at DESC
      `);

    res.json({ credentials: result.recordset });
  } catch (error) {
    console.error("BIOMETRIC LIST ERROR:", error);
    res.status(500).json({ message: "Биометрия тізімін жүктеу қатесі" });
  }
});

// ──────────────────────────────────────────────────
// 6. Биометрияны өшіру
// DELETE /api/biometric/:id
// ──────────────────────────────────────────────────
router.delete("/:id", verifyToken, async (req, res) => {
  try {
    await poolConnect;

    const result = await pool
      .request()
      .input("id", sql.Int, parseInt(req.params.id, 10))
      .input("userId", sql.Int, req.user.id)
      .query(`
        DELETE FROM biometric_credentials
        WHERE id = @id AND user_id = @userId
      `);

    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({ message: "Credential табылмады" });
    }

    res.json({ message: "Биометрия өшірілді" });
  } catch (error) {
    console.error("BIOMETRIC DELETE ERROR:", error);
    res.status(500).json({ message: "Биометрияны өшіру қатесі" });
  }
});

module.exports = router;
