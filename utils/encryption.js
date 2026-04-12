const crypto = require("crypto");

const algorithm = "aes-256-gcm";
const magic = Buffer.from("AGENC1:");

function getKey() {
  if (!process.env.ENCRYPTION_KEY) {
    throw new Error("ENCRYPTION_KEY is not configured");
  }

  return crypto.createHash("sha256").update(process.env.ENCRYPTION_KEY).digest();
}

function encryptFile(buffer) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(algorithm, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([magic, iv, authTag, encrypted]);
}

function decryptFile(encryptedBuffer) {
  if (encryptedBuffer.subarray(0, magic.length).equals(magic)) {
    const payload = encryptedBuffer.subarray(magic.length);
    const iv = payload.subarray(0, 16);
    const authTag = payload.subarray(16, 32);
    const encryptedData = payload.subarray(32);
    const decipher = crypto.createDecipheriv(algorithm, getKey(), iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encryptedData), decipher.final()]);
  }

  try {
    const iv = encryptedBuffer.subarray(0, 16);
    const authTag = encryptedBuffer.subarray(16, 32);
    const encryptedData = encryptedBuffer.subarray(32);
    const decipher = crypto.createDecipheriv(algorithm, getKey(), iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encryptedData), decipher.final()]);
  } catch {
    return encryptedBuffer;
  }
}

function isEncryptedFile(buffer) {
  return buffer.subarray(0, magic.length).equals(magic);
}

module.exports = { encryptFile, decryptFile, isEncryptedFile };
