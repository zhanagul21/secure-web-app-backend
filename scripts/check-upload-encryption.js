require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { decryptFile, isEncryptedFile } = require("../utils/encryption");

const uploadsDir = path.resolve(process.env.UPLOADS_DIR || "./uploads");
const targetFile = process.argv[2];

const knownPlainHeaders = [
  { name: "PDF", bytes: Buffer.from("%PDF") },
  { name: "JPG", bytes: Buffer.from([0xff, 0xd8, 0xff]) },
  { name: "PNG", bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
  { name: "ZIP/DOCX/PPTX/XLSX", bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04]) },
];

function detectHeader(buffer) {
  const match = knownPlainHeaders.find(({ bytes }) =>
    buffer.subarray(0, bytes.length).equals(bytes)
  );

  return match?.name || "unknown/binary";
}

function inspectFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  const decrypted = decryptFile(buffer);
  const encrypted = isEncryptedFile(buffer) || decrypted !== buffer;

  return {
    file: path.basename(filePath),
    size: buffer.length,
    encrypted,
    storedHeader: buffer.subarray(0, 16).toString("hex"),
    decryptedHeaderType: detectHeader(decrypted),
  };
}

if (!fs.existsSync(uploadsDir)) {
  console.error(`Uploads folder not found: ${uploadsDir}`);
  process.exit(1);
}

const files = targetFile
  ? [path.resolve(uploadsDir, targetFile)]
  : fs
      .readdirSync(uploadsDir)
      .map((file) => path.join(uploadsDir, file))
      .filter((filePath) => fs.statSync(filePath).isFile())
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
      .slice(0, 10);

for (const filePath of files) {
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exitCode = 1;
    continue;
  }

  console.log(JSON.stringify(inspectFile(filePath), null, 2));
}
