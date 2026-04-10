const crypto = require("crypto");

const algorithm = "aes-256-gcm";

function getKey() {
  return crypto.createHash("sha256").update(process.env.ENCRYPTION_KEY).digest();
}

function encryptFile(buffer) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(algorithm, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]);
}

function decryptFile(encryptedBuffer) {
  const iv = encryptedBuffer.subarray(0, 16);
  const authTag = encryptedBuffer.subarray(16, 32);
  const encryptedData = encryptedBuffer.subarray(32);
  const decipher = crypto.createDecipheriv(algorithm, getKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encryptedData), decipher.final()]);
}

module.exports = { encryptFile, decryptFile };