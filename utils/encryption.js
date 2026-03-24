const crypto = require("crypto");

const algorithm = "aes-256-cbc";

const secretKey = crypto
  .createHash("sha256")
  .update(process.env.ENCRYPTION_KEY || "super_secure_secret_key_123")
  .digest();

const iv = Buffer.alloc(16, 0);

function encryptFile(buffer) {
  const cipher = crypto.createCipheriv(algorithm, secretKey, iv);

  const encrypted = Buffer.concat([
    cipher.update(buffer),
    cipher.final(),
  ]);

  return encrypted;
}

function decryptFile(buffer) {
  const decipher = crypto.createDecipheriv(algorithm, secretKey, iv);

  const decrypted = Buffer.concat([
    decipher.update(buffer),
    decipher.final(),
  ]);

  return decrypted;
}

module.exports = {
  encryptFile,
  decryptFile,
};