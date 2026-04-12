const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const speakeasy = require("speakeasy");
const { sql, pool, poolConnect } = require("../config/db");
const { sendMail } = require("../utils/sendEmail");

async function logActivity(userId, actionType, actionDetails) {
  try {
    if (!userId) return;

    await poolConnect;
    await pool
      .request()
      .input("userId", sql.Int, userId)
      .input("actionType", sql.NVarChar(100), actionType)
      .input("actionDetails", sql.NVarChar(sql.MAX), actionDetails)
      .query(`
        INSERT INTO activity_logs (user_id, action_type, action_details, created_at)
        VALUES (@userId, @actionType, @actionDetails, GETDATE())
      `);
  } catch (error) {
    console.error("LOG ACTIVITY ERROR:", error);
  }
}

function generateSixDigitCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function getVisibleVerificationCode(code) {
  return process.env.SHOW_VERIFICATION_CODE === "false" ? undefined : code;
}

function getAdminEmails() {
  return (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

async function getAdminCount() {
  await poolConnect;

  const result = await pool.request().query(`
    SELECT COUNT(*) AS total
    FROM users
    WHERE role = 'admin'
  `);

  return Number(result.recordset[0]?.total || 0);
}

async function resolveAssignedRole(email, currentRole = "user") {
  const normalizedEmail = email.trim().toLowerCase();
  const adminEmails = getAdminEmails();

  if (adminEmails.includes(normalizedEmail)) {
    return "admin";
  }

  const adminCount = await getAdminCount();
  if (adminCount === 0) {
    return "admin";
  }

  return currentRole || "user";
}

async function sendMailWithFallback({ to, subject, html, code, successMessage }) {
  const visibleCode = getVisibleVerificationCode(code);

  try {
    await sendMail(to, subject, html);

    return {
      ok: true,
      message: successMessage,
      fallbackCode: visibleCode,
    };
  } catch (error) {
    console.error("MAIL DELIVERY FALLBACK:", error);

    return {
      ok: false,
      message: "Email сервисі уақытша қолжетімсіз. Сайттағы кодты қолданыңыз.",
      fallbackCode: visibleCode,
      fallbackReason: "mail_unavailable",
    };
  }
}

function signToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role || "user",
      type: "access",
    },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function signTemp2FAToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      type: "2fa_pending",
    },
    process.env.JWT_SECRET,
    { expiresIn: "5m" }
  );
}

const sendCode = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || !email.trim()) {
      return res.status(400).json({ message: "Email міндетті" });
    }

    const normalizedEmail = email.trim().toLowerCase();

    await poolConnect;

    const existing = await pool
      .request()
      .input("email", sql.NVarChar(255), normalizedEmail)
      .query(`
        SELECT TOP 1 *
        FROM users
        WHERE email = @email
      `);

    const existingUser = existing.recordset[0];

    if (existingUser && existingUser.password_hash && existingUser.is_verified) {
      return res.status(400).json({
        message: "Бұл email-пен аккаунт бұрыннан тіркелген",
      });
    }

    const code = generateSixDigitCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    if (!existingUser) {
      await pool
        .request()
        .input("fullName", sql.NVarChar(255), null)
        .input("email", sql.NVarChar(255), normalizedEmail)
        .input("passwordHash", sql.NVarChar(500), "")
        .input("role", sql.NVarChar(50), "user")
        .input("isVerified", sql.Bit, 0)
        .input("verificationCode", sql.NVarChar(10), code)
        .input("codeExpiresAt", sql.DateTime, expiresAt)
        .query(`
          INSERT INTO users (
            full_name,
            email,
            password_hash,
            role,
            is_verified,
            verification_code,
            code_expires_at,
            created_at
          )
          VALUES (
            @fullName,
            @email,
            @passwordHash,
            @role,
            @isVerified,
            @verificationCode,
            @codeExpiresAt,
            GETDATE()
          )
        `);
    } else {
      await pool
        .request()
        .input("email", sql.NVarChar(255), normalizedEmail)
        .input("verificationCode", sql.NVarChar(10), code)
        .input("codeExpiresAt", sql.DateTime, expiresAt)
        .query(`
          UPDATE users
          SET verification_code = @verificationCode,
              code_expires_at = @codeExpiresAt,
              is_verified = 0
          WHERE email = @email
        `);
    }

    const delivery = await sendMailWithFallback({
      to: normalizedEmail,
      subject: "AuthGuard Locker - Растау коды",
      code,
      successMessage: "Код email-ге жіберілді",
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px;">
          <h2>AuthGuard Locker</h2>
          <p>Сіздің растау кодыңыз:</p>
          <h1 style="letter-spacing: 4px; color: #2563eb;">${code}</h1>
          <p>Бұл код 10 минут ішінде жарамды.</p>
        </div>
      `,
    });

    return res.json({
      message: delivery.message,
      email: normalizedEmail,
      fallbackCode: delivery.fallbackCode,
      delivery: delivery.ok ? "email" : "fallback",
    });
  } catch (error) {
    console.error("SEND CODE ERROR:", error);
    return res.status(500).json({
      message: "Код жіберу кезінде қате шықты",
      error: error.message,
    });
  }
};

const verifyCode = async (req, res) => {
  try {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({ message: "Email мен код міндетті" });
    }

    const normalizedEmail = email.trim().toLowerCase();

    await poolConnect;

    const result = await pool
      .request()
      .input("email", sql.NVarChar(255), normalizedEmail)
      .query(`
        SELECT TOP 1 *
        FROM users
        WHERE email = @email
      `);

    const user = result.recordset[0];

    if (!user) {
      return res.status(404).json({ message: "Қолданушы табылмады" });
    }

    if (!user.verification_code || user.verification_code !== code.trim()) {
      return res.status(400).json({ message: "Код қате" });
    }

    if (!user.code_expires_at || new Date(user.code_expires_at) < new Date()) {
      return res.status(400).json({ message: "Кодтың жарамдылық уақыты өтті" });
    }

    return res.json({ message: "Код сәтті расталды" });
  } catch (error) {
    console.error("VERIFY CODE ERROR:", error);
    return res.status(500).json({
      message: "Кодты тексеру кезінде қате шықты",
      error: error.message,
    });
  }
};

const register = async (req, res) => {
  try {
    const { full_name, email, password } = req.body;

    if (!full_name || !email || !password) {
      return res.status(400).json({ message: "Барлық өрістерді толтырыңыз" });
    }

    if (password.length < 6) {
      return res.status(400).json({
        message: "Құпия сөз кемінде 6 таңбадан тұруы керек",
      });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const fullName = full_name.trim();

    await poolConnect;

    const result = await pool
      .request()
      .input("email", sql.NVarChar(255), normalizedEmail)
      .query(`
        SELECT TOP 1 *
        FROM users
        WHERE email = @email
      `);

    const user = result.recordset[0];

    if (!user) {
      return res.status(400).json({
        message: "Алдымен email растау кодын жіберіңіз",
      });
    }

    if (!user.verification_code || !user.code_expires_at) {
      return res.status(400).json({
        message: "Алдымен email кодын растаңыз",
      });
    }

    if (new Date(user.code_expires_at) < new Date()) {
      return res.status(400).json({
        message: "Кодтың жарамдылық уақыты өтіп кетті. Қайта код жіберіңіз",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const assignedRole = await resolveAssignedRole(
      normalizedEmail,
      user.role || "user"
    );

    await pool
      .request()
      .input("email", sql.NVarChar(255), normalizedEmail)
      .input("fullName", sql.NVarChar(255), fullName)
      .input("passwordHash", sql.NVarChar(500), hashedPassword)
      .input("role", sql.NVarChar(50), assignedRole)
      .query(`
        UPDATE users
        SET full_name = @fullName,
            password_hash = @passwordHash,
            role = @role,
            is_verified = 1,
            verification_code = NULL,
            code_expires_at = NULL
        WHERE email = @email
      `);

    const updatedResult = await pool
      .request()
      .input("email", sql.NVarChar(255), normalizedEmail)
      .query(`
        SELECT TOP 1 *
        FROM users
        WHERE email = @email
      `);

    const savedUser = updatedResult.recordset[0];

    await logActivity(savedUser.id, "REGISTER", `Тіркелу: ${normalizedEmail}`);

    return res.json({
      message: "Тіркелу сәтті аяқталды",
    });
  } catch (error) {
    console.error("REGISTER ERROR:", error);
    return res.status(500).json({
      message: "Тіркелу кезінде қате шықты",
      error: error.message,
    });
  }
};

const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Email мен пароль міндетті" });
    }

    const normalizedEmail = email.trim().toLowerCase();

    await poolConnect;

    const result = await pool
      .request()
      .input("email", sql.NVarChar(255), normalizedEmail)
      .query(`
        SELECT TOP 1 *
        FROM users
        WHERE email = @email
      `);

    const user = result.recordset[0];

    if (!user || !user.password_hash) {
      return res.status(400).json({ message: "Қате email немесе пароль" });
    }

    if (!user.is_verified) {
      return res.status(403).json({
        message: "Аккаунт расталмаған. Тіркелуді аяқтаңыз",
      });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);

    if (!isMatch) {
      return res.status(400).json({ message: "Қате email немесе пароль" });
    }

    if (user.twofa_enabled && user.twofa_secret) {
      const tempToken = signTemp2FAToken(user);

      return res.json({
        requires2fa: true,
        tempToken,
        message: "2FA кодын енгізіңіз",
      });
    }

    const assignedRole = await resolveAssignedRole(
      normalizedEmail,
      user.role || "user"
    );

    if (assignedRole !== (user.role || "user")) {
      await pool
        .request()
        .input("userId", sql.Int, user.id)
        .input("role", sql.NVarChar(50), assignedRole)
        .query(`
          UPDATE users
          SET role = @role
          WHERE id = @userId
        `);

      user.role = assignedRole;
    }

    const token = signToken(user);

    await logActivity(user.id, "LOGIN", `Жүйеге кірді: ${user.email}`);

    return res.json({
      token,
      user: {
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        role: user.role,
        twofa_enabled: user.twofa_enabled,
      },
    });
  } catch (error) {
    console.error("LOGIN ERROR:", error);
    return res.status(500).json({
      message: "Кіру кезінде қате шықты",
      error: error.message,
    });
  }
};

const verify2FA = async (req, res) => {
  try {
    const { tempToken, token } = req.body;

    if (!tempToken || !token) {
      return res.status(400).json({ message: "2FA деректері жетіспейді" });
    }

    let decoded;

    try {
      decoded = jwt.verify(tempToken, process.env.JWT_SECRET);
    } catch (error) {
      return res.status(401).json({ message: "2FA сессиясының уақыты өтіп кеткен" });
    }

    if (decoded.type !== "2fa_pending") {
      return res.status(401).json({ message: "Жарамсыз 2FA сессиясы" });
    }

    await poolConnect;

    const result = await pool
      .request()
      .input("id", sql.Int, decoded.id)
      .query(`
        SELECT TOP 1 *
        FROM users
        WHERE id = @id
      `);

    const user = result.recordset[0];

    if (!user) {
      return res.status(404).json({ message: "Қолданушы табылмады" });
    }

    if (!user.twofa_enabled || !user.twofa_secret) {
      return res.status(400).json({ message: "2FA бұл аккаунтта қосылмаған" });
    }

    const verified = speakeasy.totp.verify({
      secret: user.twofa_secret,
      encoding: "base32",
      token: token.trim(),
      window: 1,
    });

    if (!verified) {
      return res.status(400).json({ message: "2FA коды қате" });
    }

    const jwtToken = signToken(user);

    await logActivity(user.id, "LOGIN", `2FA арқылы кірді: ${user.email}`);

    return res.json({
      token: jwtToken,
      user: {
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        role: user.role,
        twofa_enabled: user.twofa_enabled,
      },
    });
  } catch (error) {
    console.error("VERIFY 2FA ERROR:", error);
    return res.status(500).json({
      message: "2FA тексеру кезінде қате шықты",
      error: error.message,
    });
  }
};

const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || !email.trim()) {
      return res.status(400).json({ message: "Email міндетті" });
    }

    const normalizedEmail = email.trim().toLowerCase();

    await poolConnect;

    const result = await pool
      .request()
      .input("email", sql.NVarChar(255), normalizedEmail)
      .query(`
        SELECT TOP 1 *
        FROM users
        WHERE email = @email
      `);

    const user = result.recordset[0];

    if (!user) {
      return res.status(404).json({ message: "Бұл email бойынша аккаунт табылмады" });
    }

    const code = generateSixDigitCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await pool
      .request()
      .input("email", sql.NVarChar(255), normalizedEmail)
      .input("resetCode", sql.NVarChar(10), code)
      .input("resetCodeExpires", sql.DateTime, expiresAt)
      .query(`
        UPDATE users
        SET reset_code = @resetCode,
            reset_code_expires = @resetCodeExpires
        WHERE email = @email
      `);

    const delivery = await sendMailWithFallback({
      to: normalizedEmail,
      subject: "AuthGuard Locker - Құпия сөзді қалпына келтіру",
      code,
      successMessage: "Құпия сөзді қалпына келтіру коды email-ге жіберілді",
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px;">
          <h2>Құпия сөзді қалпына келтіру</h2>
          <p>Сіздің қалпына келтіру кодыңыз:</p>
          <h1 style="letter-spacing: 4px; color: #2563eb;">${code}</h1>
          <p>Бұл код 10 минут ішінде жарамды.</p>
        </div>
      `,
    });

    return res.json({
      message: delivery.message,
      fallbackCode: delivery.fallbackCode,
      delivery: delivery.ok ? "email" : "fallback",
    });
  } catch (error) {
    console.error("FORGOT PASSWORD ERROR:", error);
    return res.status(500).json({
      message: "Қалпына келтіру кодын жіберу кезінде қате шықты",
      error: error.message,
    });
  }
};

const resetPassword = async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;

    if (!email || !code || !newPassword) {
      return res.status(400).json({
        message: "Email, код және жаңа пароль міндетті",
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        message: "Жаңа құпия сөз кемінде 6 таңба болуы керек",
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    await poolConnect;

    const result = await pool
      .request()
      .input("email", sql.NVarChar(255), normalizedEmail)
      .query(`
        SELECT TOP 1 *
        FROM users
        WHERE email = @email
      `);

    const user = result.recordset[0];

    if (!user) {
      return res.status(404).json({ message: "Қолданушы табылмады" });
    }

    if (!user.reset_code || user.reset_code !== code.trim()) {
      return res.status(400).json({ message: "Қалпына келтіру коды қате" });
    }

    if (!user.reset_code_expires || new Date(user.reset_code_expires) < new Date()) {
      return res.status(400).json({
        message: "Қалпына келтіру кодының уақыты өтіп кеткен",
      });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);

    await pool
      .request()
      .input("email", sql.NVarChar(255), normalizedEmail)
      .input("passwordHash", sql.NVarChar(500), hashedPassword)
      .query(`
        UPDATE users
        SET password_hash = @passwordHash,
            reset_code = NULL,
            reset_code_expires = NULL
        WHERE email = @email
      `);

    await logActivity(user.id, "PASSWORD_RESET", `Пароль жаңартылды: ${user.email}`);

    return res.json({
      message: "Құпия сөз сәтті жаңартылды",
    });
  } catch (error) {
    console.error("RESET PASSWORD ERROR:", error);
    return res.status(500).json({
      message: "Парольді жаңарту кезінде қате шықты",
      error: error.message,
    });
  }
};

module.exports = {
  sendCode,
  verifyCode,
  register,
  login,
  verify2FA,
  forgotPassword,
  resetPassword,
};
