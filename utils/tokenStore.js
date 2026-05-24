const crypto = require("crypto");
const { sql, pool, poolConnect } = require("../config/db");

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function storeRefreshToken(userId, token, expiresAt) {
  await poolConnect;
  await pool
    .request()
    .input("userId", sql.Int, userId)
    .input("tokenHash", sql.NVarChar(255), hashToken(token))
    .input("expiresAt", sql.DateTime, expiresAt)
    .query(`
      INSERT INTO refresh_tokens (user_id, token_hash, expires_at, revoked_at, created_at)
      VALUES (@userId, @tokenHash, @expiresAt, NULL, GETDATE())
    `);
}

async function findActiveRefreshToken(token) {
  await poolConnect;
  const result = await pool
    .request()
    .input("tokenHash", sql.NVarChar(255), hashToken(token))
    .query(`
      SELECT TOP 1 rt.*, u.email, u.full_name, u.role, u.twofa_enabled
      FROM refresh_tokens rt
      INNER JOIN users u ON u.id = rt.user_id
      WHERE rt.token_hash = @tokenHash
        AND rt.revoked_at IS NULL
        AND rt.expires_at > GETDATE()
    `);

  return result.recordset[0] || null;
}

async function revokeRefreshToken(token) {
  if (!token) return;

  await poolConnect;
  await pool
    .request()
    .input("tokenHash", sql.NVarChar(255), hashToken(token))
    .query(`
      UPDATE refresh_tokens
      SET revoked_at = GETDATE()
      WHERE token_hash = @tokenHash AND revoked_at IS NULL
    `);
}

async function blacklistAccessToken(token, expiresAt) {
  if (!token) return;

  await poolConnect;
  try {
    await pool
      .request()
      .input("tokenHash", sql.NVarChar(255), hashToken(token))
      .input("expiresAt", sql.DateTime, expiresAt)
      .query(`
        INSERT INTO token_blacklist (token_hash, expires_at, created_at)
        VALUES (@tokenHash, @expiresAt, GETDATE())
      `);
  } catch (error) {
    if (!/duplicate|unique|2627|2601/i.test(error.message || "")) {
      throw error;
    }
  }
}

async function isAccessTokenBlacklisted(token) {
  if (!token) return false;

  await poolConnect;
  const result = await pool
    .request()
    .input("tokenHash", sql.NVarChar(255), hashToken(token))
    .query(`
      SELECT TOP 1 id
      FROM token_blacklist
      WHERE token_hash = @tokenHash AND expires_at > GETDATE()
    `);

  return Boolean(result.recordset[0]);
}

module.exports = {
  storeRefreshToken,
  findActiveRefreshToken,
  revokeRefreshToken,
  blacklistAccessToken,
  isAccessTokenBlacklisted,
};
