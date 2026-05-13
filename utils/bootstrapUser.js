const bcrypt = require("bcryptjs");
const { sql, pool, poolConnect } = require("../config/db");

async function bootstrapDefaultUser() {
  const email = process.env.BOOTSTRAP_USER_EMAIL?.trim().toLowerCase();
  const password = process.env.BOOTSTRAP_USER_PASSWORD?.trim();
  const fullName = process.env.BOOTSTRAP_USER_FULL_NAME?.trim() || "AuthGuard Admin";
  const role = process.env.BOOTSTRAP_USER_ROLE?.trim() || "admin";

  if (!email || !password) {
    return;
  }

  await poolConnect;

  const existingResult = await pool
    .request()
    .input("email", sql.NVarChar(255), email)
    .query(`
      SELECT TOP 1 *
      FROM users
      WHERE email = @email
    `);

  const passwordHash = await bcrypt.hash(password, 12);

  if (!existingResult.recordset[0]) {
    await pool
      .request()
      .input("fullName", sql.NVarChar(255), fullName)
      .input("email", sql.NVarChar(255), email)
      .input("passwordHash", sql.NVarChar(500), passwordHash)
      .input("role", sql.NVarChar(50), role)
      .input("isVerified", sql.Bit, true)
      .query(`
        INSERT INTO users (
          full_name,
          email,
          password_hash,
          role,
          is_verified,
          created_at
        )
        VALUES (
          @fullName,
          @email,
          @passwordHash,
          @role,
          @isVerified,
          GETDATE()
        )
      `);

    console.log(`BOOTSTRAP USER CREATED: ${email}`);
    return;
  }

  await pool
    .request()
    .input("email", sql.NVarChar(255), email)
    .input("fullName", sql.NVarChar(255), fullName)
    .input("passwordHash", sql.NVarChar(500), passwordHash)
    .input("role", sql.NVarChar(50), role)
    .input("isVerified", sql.Bit, true)
    .input("twofaEnabled", sql.Bit, false)
    .query(`
      UPDATE users
      SET full_name = @fullName,
          password_hash = @passwordHash,
          role = @role,
          is_verified = @isVerified,
          verification_code = NULL,
          code_expires_at = NULL,
          reset_code = NULL,
          reset_code_expires = NULL,
          twofa_secret = NULL,
          twofa_enabled = @twofaEnabled
      WHERE email = @email
    `);

  console.log(`BOOTSTRAP USER UPDATED: ${email}`);
}

module.exports = {
  bootstrapDefaultUser,
};
