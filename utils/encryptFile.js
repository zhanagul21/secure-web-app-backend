const crypto = require("crypto");
const fs = require("fs");

const algorithm = "aes-256-cbc";
const key = crypto
  .createHash("sha256")
  .update(process.env.ENCRYPTION_KEY || "supersecretkey")
  .digest();

function encryptFile(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(algorithm, key, iv);

    const input = fs.createReadStream(inputPath);
    const output = fs.createWriteStream(outputPath);

    output.write(iv);

    input.pipe(cipher).pipe(output);

    output.on("finish", resolve);
    output.on("error", reject);
    input.on("error", reject);
  });
}

module.exports = encryptFile;