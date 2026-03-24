const crypto = require("crypto");
const fs = require("fs");

const algorithm = "aes-256-cbc";
const key = crypto
  .createHash("sha256")
  .update(process.env.ENCRYPTION_KEY || "supersecretkey")
  .digest();

function decryptFile(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const input = fs.createReadStream(inputPath, { start: 16 });
    const fd = fs.openSync(inputPath, "r");
    const iv = Buffer.alloc(16);
    fs.readSync(fd, iv, 0, 16, 0);
    fs.closeSync(fd);

    const decipher = crypto.createDecipheriv(algorithm, key, iv);
    const output = fs.createWriteStream(outputPath);

    input.pipe(decipher).pipe(output);

    output.on("finish", resolve);
    output.on("error", reject);
    input.on("error", reject);
  });
}

module.exports = decryptFile;