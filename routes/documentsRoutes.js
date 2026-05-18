const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const mammoth = require("mammoth");
const WordExtractor = require("word-extractor");
const XLSX = require("xlsx");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { sql, pool, poolConnect } = require("../config/db");
const { encryptFile, decryptFile, isEncryptedFile } = require("../utils/encryption");
const { isAccessTokenBlacklisted } = require("../utils/tokenStore");

const execFileAsync = promisify(execFile);

const uploadsDir = path.resolve(process.env.UPLOADS_DIR || "./uploads");
const storeFilesInDatabase =
  Boolean(process.env.DATABASE_URL) && process.env.DB_DRIVER !== "mssql";
const configuredUploadSizeMb = Number.parseInt(
  process.env.MAX_UPLOAD_SIZE_MB || "500",
  10
);
const maxUploadSizeMb =
  Number.isFinite(configuredUploadSizeMb) && configuredUploadSizeMb > 0
    ? configuredUploadSizeMb
    : 500;
const maxUploadSizeBytes = maxUploadSizeMb * 1024 * 1024;
const renderPostgresStorageLimitGb = Number.parseFloat(
  process.env.RENDER_POSTGRES_STORAGE_GB || "1"
);
const DOCX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const allowedFileTypes = new Map([
  [".pdf", ["application/pdf"]],
  [".png", ["image/png"]],
  [".jpg", ["image/jpeg"]],
  [".jpeg", ["image/jpeg"]],
  [".doc", ["application/msword"]],
  [".docx", [DOCX_MIME_TYPE]],
  [".xls", ["application/vnd.ms-excel", "application/octet-stream"]],
  [".xlsx", [XLSX_MIME_TYPE]],
  [".ppt", ["application/vnd.ms-powerpoint"]],
  [".pptx", ["application/vnd.openxmlformats-officedocument.presentationml.presentation"]],
  [".txt", ["text/plain"]],
]);
const frontendOrigins = (process.env.FRONTEND_URL || "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const normalizedOriginalName = Buffer.from(file.originalname, "latin1").toString(
      "utf8"
    );
    const safeOriginalName = normalizedOriginalName.replace(/[^\w.\-() ]/g, "_");
    cb(null, `${Date.now()}-${safeOriginalName}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: maxUploadSizeBytes },
  fileFilter: (req, file, cb) => {
    const normalizedOriginalName = Buffer.from(file.originalname, "latin1").toString(
      "utf8"
    );
    const extension = path.extname(normalizedOriginalName).toLowerCase();
    const mimeTypes = allowedFileTypes.get(extension);

    if (!mimeTypes) {
      return cb(new Error("Бұл файл түріне рұқсат жоқ"));
    }

    if (file.mimetype && !mimeTypes.includes(file.mimetype)) {
      return cb(new Error("Файл кеңейтімі мен MIME түрі сәйкес емес"));
    }

    return cb(null, true);
  },
});

const uploadMiddleware = (req, res, next) => {
  upload.single("file")(req, res, (error) => {
    if (!error) {
      return next();
    }

    console.error("UPLOAD MIDDLEWARE ERROR:", error);

    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        message: `Файл көлемі ${maxUploadSizeMb}MB-тан аспауы керек.`,
      });
    }

    return res.status(400).json({
      message: error.message || "Файлды қабылдау кезінде қате шықты.",
    });
  });
};

const authMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ message: "Токен жоқ" });
    }

    const token = authHeader.split(" ")[1];
    if (await isAccessTokenBlacklisted(token)) {
      return res.status(401).json({ message: "Сессия аяқталған. Қайта кіріңіз." });
    }

    req.user = jwt.verify(token, process.env.JWT_SECRET);
    if (req.user.type !== "access") {
      return res.status(401).json({ message: "Жарамсыз токен түрі" });
    }
    next();
  } catch (error) {
    return res.status(401).json({ message: "Жарамсыз токен" });
  }
};

const getLibreOfficeExecutable = () => {
  const configuredPath = process.env.LIBREOFFICE_PATH;

  if (configuredPath && (process.platform === "win32" || !configuredPath.includes(":\\"))) {
    return configuredPath;
  }

  return process.platform === "win32" ? "soffice.exe" : "soffice";
};

const getLibreOfficeCandidates = () => {
  const candidates = [
    getLibreOfficeExecutable(),
    "/usr/bin/libreoffice",
    "/usr/bin/soffice",
    "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
    "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
    process.platform === "win32" ? "libreoffice.exe" : "libreoffice",
    process.platform === "win32" ? "soffice.exe" : "soffice",
  ];

  return [...new Set(candidates.filter(Boolean))];
};

const execLibreOffice = async (args) => {
  let lastError = null;

  for (const executable of getLibreOfficeCandidates()) {
    try {
      return await execFileAsync(executable, args, {
        timeout: 90000,
        env: { ...process.env, HOME: process.env.HOME || os.tmpdir() },
      });
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("LibreOffice табылмады");
};

const convertDocToDocx = async (inputPath) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "authguard-doc-"));

  await execLibreOffice([
    "--headless",
    "--nologo",
    "--nofirststartwizard",
    "--nodefault",
    "--nolockcheck",
    "--convert-to",
    "docx",
    "--outdir",
    tempDir,
    inputPath,
  ]);

  const baseName = path.basename(inputPath, path.extname(inputPath));
  const convertedPath = path.join(tempDir, `${baseName}.docx`);

  if (!fs.existsSync(convertedPath)) {
    throw new Error("DOC файлын DOCX-қа айналдыру мүмкін болмады");
  }

  return { convertedPath, tempDir };
};

const convertDocumentToPdf = async (inputPath) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "authguard-doc-"));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "authguard-lo-"));

  try {
    await execLibreOffice([
      "--headless",
      "--nologo",
      "--nofirststartwizard",
      "--nodefault",
      "--nolockcheck",
      `-env:UserInstallation=file://${profileDir.replace(/\\/g, "/")}`,
      "--convert-to",
      "pdf:writer_pdf_Export",
      "--outdir",
      tempDir,
      inputPath,
    ]);
  } finally {
    cleanupDir(profileDir);
  }

  const baseName = path.basename(inputPath, path.extname(inputPath));
  const convertedPath = path.join(tempDir, `${baseName}.pdf`);

  if (!fs.existsSync(convertedPath)) {
    throw new Error("WORD файлын PDF-ке айналдыру мүмкін болмады");
  }

  return { convertedPath, tempDir };
};

const sendConvertedPdfPreview = async (res, inputPath, currentTempDir) => {
  const { convertedPath, tempDir } = await convertDocumentToPdf(inputPath);
  cleanupDir(currentTempDir);

  const pdfBuffer = await fs.promises.readFile(convertedPath);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "inline");
  res.send(pdfBuffer);

  return tempDir;
};

const sendDocxHtmlPreview = async (res, buffer, title, compact = false) => {
  const html = await renderDocxBufferPreview(buffer, title, compact);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
};

const sendDocHtmlPreview = async (res, filePath, title, compact = false) => {
  const html = await renderDocPathTextPreview(filePath, title, compact);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
};

const cleanupDir = (dirPath) => {
  try {
    if (dirPath && fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  } catch (error) {
    console.error("CLEANUP ERROR:", error);
  }
};

const writeLog = async (userId, actionType, actionDetails) => {
  try {
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
    console.error("DOCUMENT LOG ERROR:", error);
  }
};

const getDocumentByIdForUser = async (documentId, userId) => {
  await poolConnect;

  const result = await pool
    .request()
    .input("documentId", sql.Int, parseInt(documentId, 10))
    .input("userId", sql.Int, userId)
    .query(`
      SELECT TOP 1 *
      FROM documents
      WHERE id = @documentId AND user_id = @userId AND deleted_at IS NULL
    `);

  return result.recordset[0];
};

const getDocumentMetaByIdForUser = async (documentId, userId) => {
  await poolConnect;

  const result = await pool
    .request()
    .input("documentId", sql.Int, parseInt(documentId, 10))
    .input("userId", sql.Int, userId)
    .query(`
      SELECT TOP 1
        id, user_id, title, category, description, filename, original_name,
        mime_type, file_size, created_at
      FROM documents
      WHERE id = @documentId AND user_id = @userId AND deleted_at IS NULL
    `);

  return result.recordset[0];
};

const getDeletedDocumentByIdForUser = async (documentId, userId) => {
  await poolConnect;

  const result = await pool
    .request()
    .input("documentId", sql.Int, parseInt(documentId, 10))
    .input("userId", sql.Int, userId)
    .query(`
      SELECT TOP 1 *
      FROM documents
      WHERE id = @documentId AND user_id = @userId AND deleted_at IS NOT NULL
    `);

  return result.recordset[0];
};

const writeTempDocumentFile = (doc, buffer) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "authguard-preview-"));
  const extension = path.extname(doc.original_name || doc.filename || ".bin") || ".bin";
  const safeOriginalName = `document${extension}`;
  const tempPath = path.join(tempDir, safeOriginalName);

  fs.writeFileSync(tempPath, buffer);

  return { tempDir, tempPath };
};

const resolveFrontendBaseUrl = (req) => {
  const requestOrigin = req.get("origin");

  if (requestOrigin && frontendOrigins.includes(requestOrigin)) {
    return requestOrigin;
  }

  return (
    frontendOrigins.find((origin) => origin.startsWith("https://")) ||
    frontendOrigins[0] ||
    "http://localhost:5173"
  );
};

const encryptUploadedFile = async (file) => {
  const storedBuffer = await fs.promises.readFile(file.path);

  if (!isEncryptedFile(storedBuffer)) {
    await fs.promises.writeFile(file.path, encryptFile(storedBuffer));
  }
};

const validateUploadedFileSignature = async (file) => {
  const buffer = await fs.promises.readFile(file.path);
  const normalizedOriginalName = Buffer.from(file.originalname, "latin1").toString(
    "utf8"
  );
  const extension = path.extname(normalizedOriginalName).toLowerCase();

  const startsWith = (...bytes) =>
    bytes.every((byte, index) => buffer[index] === byte);
  const textSample = buffer.subarray(0, Math.min(buffer.length, 512));
  const looksLikeText = !textSample.includes(0);
  const zipBasedOffice = startsWith(0x50, 0x4b, 0x03, 0x04);

  const isValid =
    (extension === ".pdf" && startsWith(0x25, 0x50, 0x44, 0x46)) ||
    (extension === ".png" && startsWith(0x89, 0x50, 0x4e, 0x47)) ||
    ((extension === ".jpg" || extension === ".jpeg") &&
      startsWith(0xff, 0xd8, 0xff)) ||
    ((extension === ".docx" || extension === ".xlsx" || extension === ".pptx") && zipBasedOffice) ||
    ((extension === ".doc" || extension === ".ppt") &&
      (startsWith(0xd0, 0xcf, 0x11, 0xe0) || zipBasedOffice)) ||
    (extension === ".xls" &&
      (startsWith(0xd0, 0xcf, 0x11, 0xe0) || zipBasedOffice)) ||
    (extension === ".txt" && looksLikeText);

  if (!isValid) {
    throw new Error("Файл мазмұны таңдалған түрге сәйкес емес");
  }
};

const wrapPreviewHtml = (title, bodyHtml, compact = false) => `
  <html>
    <head>
      <meta charset="UTF-8" />
      <title>${title}</title>
      <style>
        * { box-sizing: border-box; }
        html {
          background: #eef4fb;
        }
        body {
          font-family: Arial, sans-serif;
          padding: ${compact ? "16px" : "24px"};
          line-height: ${compact ? "1.6" : "1.7"};
          margin: 0 auto;
          background: #eef4fb;
          color: #111827;
          overflow: auto;
        }
        .document-page {
          background: #fff;
          border: 1px solid #dbe7f3;
          border-radius: 18px;
          box-shadow: 0 16px 40px rgba(15, 23, 42, 0.08);
          margin: 0 auto;
          max-width: 100%;
          overflow: auto;
          padding: ${compact ? "18px" : "28px"};
        }
        img { max-width: 100%; height: auto; }
        .table-wrap {
          max-width: 100%;
          overflow: auto;
        }
        table {
          border-collapse: collapse;
          min-width: 100%;
          table-layout: auto;
          width: max-content;
        }
        td, th {
          border: 1px solid #cbd5e1;
          padding: 7px 9px;
          vertical-align: top;
          white-space: pre-wrap;
        }
        p { margin: 0 0 12px; }
        .sheet-preview {
          margin-bottom: 28px;
        }
        .sheet-preview h2 {
          font-size: 18px;
          margin: 0 0 14px;
        }
        pre {
          white-space: pre-wrap;
          word-break: break-word;
          background: #f8fafc;
          border: 1px solid #e2e8f0;
          border-radius: 16px;
          padding: 16px;
        }
        .word-fallback {
          white-space: pre;
          word-break: normal;
          display: inline-block;
          min-width: max-content;
          max-width: none;
          overflow: visible;
          tab-size: 8;
          font-family: "Courier New", monospace;
          font-size: ${compact ? "9px" : "10px"};
          line-height: 1.35;
          transform-origin: top left;
        }
        .word-fallback-wrap {
          max-width: 100%;
          overflow: auto;
          padding-bottom: 8px;
        }
        @media print {
          html, body {
            background: #fff;
          }
          .document-page {
            border: 0;
            box-shadow: none;
          }
        }
      </style>
    </head>
    <body>
      <main class="document-page">${bodyHtml}</main>
      <script>
        document.querySelectorAll("table").forEach((table) => {
          if (table.parentElement && table.parentElement.classList.contains("table-wrap")) return;
          const wrapper = document.createElement("div");
          wrapper.className = "table-wrap";
          table.parentNode.insertBefore(wrapper, table);
          wrapper.appendChild(table);
        });

        function fitWordFallback() {
          document.querySelectorAll(".word-fallback").forEach((pre) => {
            pre.style.transform = "";
            pre.style.marginBottom = "";
            const wrapper = pre.parentElement;
            const availableWidth = wrapper ? wrapper.clientWidth : window.innerWidth;
            const naturalWidth = pre.scrollWidth;
            if (!availableWidth || !naturalWidth || naturalWidth <= availableWidth) return;
            const scale = Math.max(0.45, Math.min(1, availableWidth / naturalWidth));
            pre.style.transform = "scale(" + scale + ")";
            pre.style.marginBottom = ((pre.scrollHeight * scale) - pre.scrollHeight) + "px";
          });
        }

        window.addEventListener("load", fitWordFallback);
        window.addEventListener("resize", fitWordFallback);
      </script>
    </body>
  </html>
`;

const escapeHtml = (text) =>
  String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const isSpreadsheetDocument = (doc) => {
  const extension = path.extname(doc.original_name || doc.filename || "").toLowerCase();
  return (
    doc.mime_type === "application/vnd.ms-excel" ||
    doc.mime_type === XLSX_MIME_TYPE ||
    extension === ".xls" ||
    extension === ".xlsx"
  );
};

const renderSpreadsheetPreview = (buffer, title, compact = false) => {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheets = workbook.SheetNames.map((sheetName) => {
    const worksheet = workbook.Sheets[sheetName];
    const tableHtml = XLSX.utils.sheet_to_html(worksheet, {
      id: "",
      editable: false,
    });

    return `
      <section class="sheet-preview">
        <h2>${escapeHtml(sheetName)}</h2>
        ${tableHtml}
      </section>
    `;
  }).join("");

  if (!sheets.trim()) {
    throw new Error("SPREADSHEET_PREVIEW_EMPTY");
  }

  return wrapPreviewHtml(title, sheets, compact);
};

const renderDocxBufferPreview = async (buffer, title, compact = false) => {
  const htmlResult = await mammoth.convertToHtml({ buffer });
  const cleanedHtml = (htmlResult.value || "").trim();

  if (cleanedHtml) {
    return wrapPreviewHtml(title, cleanedHtml, compact);
  }

  const textResult = await mammoth.extractRawText({ buffer });
  const cleanedText = (textResult.value || "").trim();

  if (cleanedText) {
    return wrapPreviewHtml(
      title,
      `<div class="word-fallback-wrap"><pre class="word-fallback">${escapeHtml(cleanedText)}</pre></div>`,
      compact
    );
  }

  throw new Error("WORD_PREVIEW_EMPTY");
};

const renderDocxPathPreview = async (docxPath, title, compact = false) => {
  const fileBuffer = await fs.promises.readFile(docxPath);
  return renderDocxBufferPreview(fileBuffer, title, compact);
};

const renderDocPathTextPreview = async (docPath, title, compact = false) => {
  const extractor = new WordExtractor();
  const document = await extractor.extract(docPath);
  const cleanedText = (document.getBody() || "").trim();

  if (!cleanedText) {
    throw new Error("DOC_PREVIEW_EMPTY");
  }

  return wrapPreviewHtml(
    title,
    `<div class="word-fallback-wrap"><pre class="word-fallback">${escapeHtml(cleanedText)}</pre></div>`,
    compact
  );
};

const getStoredDocumentBuffer = (doc) => {
  if (doc.file_data) {
    return Buffer.isBuffer(doc.file_data)
      ? doc.file_data
      : Buffer.from(doc.file_data);
  }

  const filePath = path.join(uploadsDir, doc.filename);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  return fs.readFileSync(filePath);
};

const getReadableDocument = (doc) => {
  if (doc.file_data) {
    const storedBuffer = getStoredDocumentBuffer(doc);
    const encrypted = isEncryptedFile(storedBuffer);
    const buffer = decryptFile(storedBuffer);

    if (!encrypted && buffer === storedBuffer) {
      const { tempDir, tempPath } = writeTempDocumentFile(doc, storedBuffer);
      return { filePath: tempPath, buffer: storedBuffer, tempDir };
    }

    const { tempDir, tempPath } = writeTempDocumentFile(doc, buffer);
    return { filePath: tempPath, buffer, tempDir };
  }

  const filePath = path.join(uploadsDir, doc.filename);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  const storedBuffer = getStoredDocumentBuffer(doc);

  const encrypted = isEncryptedFile(storedBuffer);
  const buffer = decryptFile(storedBuffer);

  if (!encrypted && buffer === storedBuffer) {
    return { filePath, buffer: storedBuffer, tempDir: null };
  }

  const { tempDir, tempPath } = writeTempDocumentFile(doc, buffer);

  return { filePath: tempPath, buffer, tempDir };
};

router.get("/my", authMiddleware, async (req, res) => {
  try {
    await poolConnect;

    const result = await pool
      .request()
      .input("userId", sql.Int, req.user.id)
      .query(`
        SELECT
          id, user_id, title, category, description, filename, original_name,
          mime_type, file_size, created_at
        FROM documents
        WHERE user_id = @userId AND deleted_at IS NULL
        ORDER BY created_at DESC
      `);

    res.json({ documents: result.recordset });
  } catch (error) {
    console.error("GET DOCUMENTS ERROR:", error);
    res.status(500).json({ message: "Құжаттарды жүктеу кезінде қате шықты" });
  }
});

router.post("/add", authMiddleware, uploadMiddleware, async (req, res, next) => {
  if (!req.file) {
    return next();
  }

  try {
    await validateUploadedFileSignature(req.file);
    await encryptUploadedFile(req.file);
    return next();
  } catch (error) {
    console.error("ENCRYPT UPLOAD ERROR:", error);
    if (req.file?.path && fs.existsSync(req.file.path)) {
      try {
        await fs.promises.unlink(req.file.path);
      } catch (cleanupError) {
        console.error("INVALID UPLOAD CLEANUP ERROR:", cleanupError);
      }
    }

    return res.status(400).json({
      message: error.message || "Файлды қабылдау кезінде қате шықты.",
    });
  }
}, async (req, res) => {
  try {
    const { title, category, description } = req.body;

    if (!title?.trim() || !category?.trim()) {
      return res
        .status(400)
        .json({ message: "Құжат атауы мен категория міндетті" });
    }

    if (!req.file) {
      return res.status(400).json({ message: "Файл таңдалмаған" });
    }

    await poolConnect;

    const normalizedOriginalName = Buffer.from(req.file.originalname, "latin1").toString(
      "utf8"
    );

    const addRequest = pool
      .request()
      .input("userId", sql.Int, req.user.id)
      .input("title", sql.NVarChar(255), title.trim())
      .input("category", sql.NVarChar(255), category.trim())
      .input("description", sql.NVarChar(sql.MAX), description || "")
      .input("filename", sql.NVarChar(500), req.file.filename)
      .input("originalName", sql.NVarChar(500), normalizedOriginalName)
      .input("mimeType", sql.NVarChar(255), req.file.mimetype)
      .input("fileSize", sql.Int, req.file.size);

    if (storeFilesInDatabase) {
      addRequest.input(
        "fileData",
        sql.NVarChar(sql.MAX),
        await fs.promises.readFile(req.file.path)
      );
    }

    const result = await addRequest.query(`
        INSERT INTO documents (
          user_id, title, category, description, filename, original_name, mime_type, file_size
          ${storeFilesInDatabase ? ", file_data" : ""}
        )
        OUTPUT INSERTED.*
        VALUES (
          @userId, @title, @category, @description, @filename, @originalName, @mimeType, @fileSize
          ${storeFilesInDatabase ? ", @fileData" : ""}
        )
      `);

    if (storeFilesInDatabase && fs.existsSync(req.file.path)) {
      await fs.promises.unlink(req.file.path);
    }

    await writeLog(req.user.id, "DOCUMENT_ADD", `Құжат қосылды: ${title.trim()}`);

    res.json({
      message: "Құжат сәтті жүктелді",
      document: {
        ...result.recordset[0],
        file_data: undefined,
      },
    });
  } catch (error) {
    console.error("ADD DOCUMENT ERROR:", error);

    if (req.file?.path && storeFilesInDatabase && fs.existsSync(req.file.path)) {
      try {
        await fs.promises.unlink(req.file.path);
      } catch (cleanupError) {
        console.error("UPLOAD CLEANUP ERROR:", cleanupError);
      }
    }

    res.status(500).json({
      message: error.message || "Құжат жүктеу кезінде қате шықты",
    });
  }
});

router.get("/limits", authMiddleware, async (req, res) => {
  res.json({
    maxUploadSizeMb,
    maxUploadSizeBytes,
    storage: {
      mode: storeFilesInDatabase ? "database" : "filesystem",
      renderPostgresStorageLimitGb:
        Number.isFinite(renderPostgresStorageLimitGb) &&
        renderPostgresStorageLimitGb > 0
          ? renderPostgresStorageLimitGb
          : null,
    },
  });
});

router.get("/trash", authMiddleware, async (req, res) => {
  try {
    await poolConnect;

    const result = await pool
      .request()
      .input("userId", sql.Int, req.user.id)
      .query(`
        SELECT
          id, user_id, title, category, description, filename, original_name,
          mime_type, file_size, created_at, deleted_at
        FROM documents
        WHERE user_id = @userId AND deleted_at IS NOT NULL
        ORDER BY deleted_at DESC
      `);

    res.json({ documents: result.recordset });
  } catch (error) {
    console.error("GET TRASH DOCUMENTS ERROR:", error);
    res.status(500).json({ message: "Корзинаны жүктеу кезінде қате шықты" });
  }
});

router.get("/view/:id", authMiddleware, async (req, res) => {
  try {
    const doc = await getDocumentMetaByIdForUser(req.params.id, req.user.id);

    if (!doc) {
      return res.status(404).json({ message: "Құжат табылмады" });
    }

    await writeLog(req.user.id, "DOCUMENT_VIEW", `Құжат ашылды: ${doc.title}`);

    res.json({ document: doc });
  } catch (error) {
    console.error("VIEW DOCUMENT ERROR:", error);
    res.status(500).json({ message: "Құжатты ашу кезінде қате шықты" });
  }
});

router.get("/preview/:id", authMiddleware, async (req, res) => {
  let tempDirToDelete = null;

  try {
    const doc = await getDocumentByIdForUser(req.params.id, req.user.id);

    if (!doc) {
      return res.status(404).json({ message: "Құжат табылмады" });
    }

    if (!doc.filename) {
      return res.status(400).json({ message: "Файл аты базада жоқ" });
    }

    const readable = getReadableDocument(doc);

    if (!readable) {
      return res.status(404).json({ message: "Файл серверде табылмады" });
    }

    tempDirToDelete = readable.tempDir;

    if (doc.mime_type === "application/pdf") {
      res.setHeader("Content-Type", "application/pdf");
      return res.send(readable.buffer);
    }

    if (doc.mime_type?.startsWith("image/")) {
      res.setHeader("Content-Type", doc.mime_type);
      return res.send(readable.buffer);
    }

    if (doc.mime_type === "text/plain") {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      return res.send(readable.buffer);
    }

    if (isSpreadsheetDocument(doc)) {
      const previewHtml = renderSpreadsheetPreview(readable.buffer, doc.title);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send(previewHtml);
    }

    if (
      doc.mime_type === DOCX_MIME_TYPE
    ) {
      if (req.query.raw === "1") {
        res.setHeader("Content-Type", DOCX_MIME_TYPE);
        res.setHeader("Content-Disposition", "inline");
        return res.send(readable.buffer);
      }

      try {
        tempDirToDelete = await sendConvertedPdfPreview(
          res,
          readable.filePath,
          tempDirToDelete
        );
        return;
      } catch (error) {
        console.error("DOCX PDF PREVIEW ERROR:", error);
        await sendDocxHtmlPreview(res, readable.buffer, doc.title);
        return;
      }
    }

    if (doc.mime_type === "application/msword") {
      try {
        tempDirToDelete = await sendConvertedPdfPreview(
          res,
          readable.filePath,
          tempDirToDelete
        );
        return;
      } catch (error) {
        console.error("DOC PDF PREVIEW ERROR:", error);
        await sendDocHtmlPreview(res, readable.filePath, doc.title);
        return;
      }
    }

    return res.status(400).json({
      message: "Бұл файл түріне preview қолдау көрсетілмейді",
    });
  } catch (error) {
    console.error("PREVIEW DOCUMENT ERROR:", error);
    return res.status(500).json({
      message: error.message || "Preview ашылмады",
    });
  } finally {
    cleanupDir(tempDirToDelete);
  }
});

router.get("/encryption-proof/:id", authMiddleware, async (req, res) => {
  try {
    const doc = await getDocumentByIdForUser(req.params.id, req.user.id);

    if (!doc) {
      return res.status(404).json({ message: "Құжат табылмады" });
    }

    const storedBuffer = getStoredDocumentBuffer(doc);
    if (!storedBuffer) {
      return res.status(404).json({ message: "Файл серверде табылмады" });
    }

    const encrypted = isEncryptedFile(storedBuffer);
    const decryptedBuffer = decryptFile(storedBuffer);
    const ciphertextHash = crypto
      .createHash("sha256")
      .update(storedBuffer)
      .digest("hex");

    res.json({
      encrypted,
      algorithm: "AES-256-GCM",
      marker: encrypted ? "AGENC1:" : "жоқ",
      storedHeaderHex: storedBuffer.subarray(0, 16).toString("hex"),
      storedHeaderText: storedBuffer.subarray(0, 7).toString("utf8"),
      storedSizeBytes: storedBuffer.length,
      originalSizeBytes: decryptedBuffer.length,
      ciphertextSha256: ciphertextHash,
      authTagBytes: encrypted ? 16 : 0,
      ivBytes: encrypted ? 16 : 0,
      databaseStorage: Boolean(doc.file_data),
      explanation:
        "Серверде сақталған файл AES-256-GCM арқылы ciphertext ретінде тұр. Preview/download кезінде ғана backend decrypt жасайды.",
    });
  } catch (error) {
    console.error("ENCRYPTION PROOF ERROR:", error);
    res.status(500).json({ message: "Шифрлау дәлелін алу кезінде қате шықты" });
  }
});

router.get("/download/:id", authMiddleware, async (req, res) => {
  try {
    const doc = await getDocumentByIdForUser(req.params.id, req.user.id);

    if (!doc) {
      return res.status(404).json({ message: "Құжат табылмады" });
    }

    if (!doc.filename) {
      return res.status(400).json({ message: "Файл аты базада жоқ" });
    }

    const readable = getReadableDocument(doc);

    if (!readable) {
      return res.status(404).json({ message: "Файл серверде табылмады" });
    }

    await writeLog(
      req.user.id,
      "DOCUMENT_DOWNLOAD",
      `Құжат жүктелді: ${doc.title}`
    );

    res.setHeader("Content-Type", doc.mime_type || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(doc.original_name || doc.filename)}"`);
    res.send(readable.buffer);
    return cleanupDir(readable.tempDir);
  } catch (error) {
    console.error("DOWNLOAD DOCUMENT ERROR:", error);
    return res.status(500).json({
      message: "Құжатты жүктеу кезінде қате шықты",
    });
  }
});

router.delete("/delete/:id", authMiddleware, async (req, res) => {
  try {
    const doc = await getDocumentByIdForUser(req.params.id, req.user.id);

    if (!doc) {
      return res.status(404).json({ message: "Құжат табылмады" });
    }

    await poolConnect;

    await pool
      .request()
      .input("documentId", sql.Int, parseInt(req.params.id, 10))
      .query(`
        DELETE FROM shared_links
        WHERE document_id = @documentId
      `);

    await pool
      .request()
      .input("documentId", sql.Int, parseInt(req.params.id, 10))
      .input("userId", sql.Int, req.user.id)
      .query(`
        UPDATE documents
        SET deleted_at = GETDATE()
        WHERE id = @documentId AND user_id = @userId AND deleted_at IS NULL
      `);

    await writeLog(
      req.user.id,
      "DOCUMENT_DELETE",
      `Құжат өшірілді: ${doc.title}`
    );

    res.json({ message: "Құжат сәтті өшірілді" });
  } catch (error) {
    console.error("DELETE DOCUMENT ERROR:", error);
    res.status(500).json({
      message: error.message || "Құжатты өшіру кезінде қате шықты",
    });
  }
});

router.patch("/restore/:id", authMiddleware, async (req, res) => {
  try {
    const doc = await getDeletedDocumentByIdForUser(req.params.id, req.user.id);

    if (!doc) {
      return res.status(404).json({ message: "Корзинада құжат табылмады" });
    }

    await poolConnect;

    await pool
      .request()
      .input("documentId", sql.Int, parseInt(req.params.id, 10))
      .input("userId", sql.Int, req.user.id)
      .query(`
        UPDATE documents
        SET deleted_at = NULL
        WHERE id = @documentId AND user_id = @userId
      `);

    await writeLog(req.user.id, "DOCUMENT_RESTORE", `Құжат қалпына келтірілді: ${doc.title}`);

    res.json({ message: "Құжат қалпына келтірілді" });
  } catch (error) {
    console.error("RESTORE DOCUMENT ERROR:", error);
    res.status(500).json({ message: "Құжатты қалпына келтіру кезінде қате шықты" });
  }
});

router.delete("/permanent/:id", authMiddleware, async (req, res) => {
  try {
    const doc = await getDeletedDocumentByIdForUser(req.params.id, req.user.id);

    if (!doc) {
      return res.status(404).json({ message: "Корзинада құжат табылмады" });
    }

    const filePath = doc.filename ? path.join(uploadsDir, doc.filename) : null;

    await poolConnect;

    await pool
      .request()
      .input("documentId", sql.Int, parseInt(req.params.id, 10))
      .query(`
        DELETE FROM shared_links
        WHERE document_id = @documentId
      `);

    await pool
      .request()
      .input("documentId", sql.Int, parseInt(req.params.id, 10))
      .input("userId", sql.Int, req.user.id)
      .query(`
        DELETE FROM documents
        WHERE id = @documentId AND user_id = @userId
      `);

    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    await writeLog(req.user.id, "DOCUMENT_PERMANENT_DELETE", `Құжат біржола өшірілді: ${doc.title}`);

    res.json({ message: "Құжат біржола өшірілді" });
  } catch (error) {
    console.error("PERMANENT DELETE DOCUMENT ERROR:", error);
    res.status(500).json({ message: "Құжатты біржола өшіру кезінде қате шықты" });
  }
});

router.post("/share/:id", authMiddleware, async (req, res) => {
  try {
    const doc = await getDocumentByIdForUser(req.params.id, req.user.id);

    if (!doc) {
      return res.status(404).json({ message: "Құжат табылмады" });
    }

    const { durationMinutes = 60 } = req.body;
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + Number(durationMinutes) * 60 * 1000);

    await poolConnect;

    await pool
      .request()
      .input("documentId", sql.Int, doc.id)
      .input("token", sql.NVarChar(255), token)
      .input("expiresAt", sql.DateTime, expiresAt)
      .input("createdBy", sql.Int, req.user.id)
      .query(`
        INSERT INTO shared_links (document_id, token, expires_at, created_by)
        VALUES (@documentId, @token, @expiresAt, @createdBy)
      `);

    await writeLog(
      req.user.id,
      "DOCUMENT_SHARE",
      `Сілтеме жасалды: ${doc.title}, ${durationMinutes} минут`
    );

    const shareUrl = `${resolveFrontendBaseUrl(req)}/shared/${token}`;

    res.json({
      message: "Сілтеме сәтті жасалды",
      shareUrl,
      expiresAt,
    });
  } catch (error) {
    console.error("SHARE DOCUMENT ERROR:", error);
    res.status(500).json({
      message: error.message || "Сілтеме жасау кезінде қате шықты",
    });
  }
});

router.get("/shared/:token", async (req, res) => {
  let tempDirToDelete = null;

  try {
    await poolConnect;

    const result = await pool
      .request()
      .input("token", sql.NVarChar(255), req.params.token)
      .query(`
        SELECT TOP 1 d.*, s.expires_at
        FROM shared_links s
        INNER JOIN documents d ON d.id = s.document_id
        WHERE s.token = @token AND d.deleted_at IS NULL
        ORDER BY s.id DESC
      `);

    const doc = result.recordset[0];

    if (!doc) {
      return res.status(404).json({ message: "Сілтеме табылмады" });
    }

    if (new Date(doc.expires_at) < new Date()) {
      return res.status(410).json({ message: "Сілтеменің уақыты өтіп кеткен" });
    }

    res.setHeader("X-Expires-At", new Date(doc.expires_at).toISOString());

    const readable = getReadableDocument(doc);

    if (!readable) {
      return res.status(404).json({ message: "Файл серверде табылмады" });
    }

    tempDirToDelete = readable.tempDir;

    if (doc.mime_type === "application/pdf") {
      res.setHeader("Content-Type", "application/pdf");
      return res.send(readable.buffer);
    }

    if (doc.mime_type?.startsWith("image/")) {
      res.setHeader("Content-Type", doc.mime_type);
      return res.send(readable.buffer);
    }

    if (doc.mime_type === "text/plain") {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      return res.send(readable.buffer);
    }

    if (isSpreadsheetDocument(doc)) {
      const previewHtml = renderSpreadsheetPreview(readable.buffer, doc.title, true);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send(previewHtml);
    }

    if (
      doc.mime_type === DOCX_MIME_TYPE
    ) {
      if (req.query.raw === "1") {
        res.setHeader("Content-Type", DOCX_MIME_TYPE);
        res.setHeader("Content-Disposition", "inline");
        return res.send(readable.buffer);
      }

      try {
        tempDirToDelete = await sendConvertedPdfPreview(
          res,
          readable.filePath,
          tempDirToDelete
        );
        return;
      } catch (error) {
        console.error("SHARED DOCX PDF PREVIEW ERROR:", error);
        await sendDocxHtmlPreview(res, readable.buffer, doc.title, true);
        return;
      }
    }

    if (doc.mime_type === "application/msword") {
      try {
        tempDirToDelete = await sendConvertedPdfPreview(
          res,
          readable.filePath,
          tempDirToDelete
        );
        return;
      } catch (error) {
        console.error("SHARED DOC PDF PREVIEW ERROR:", error);
        await sendDocHtmlPreview(res, readable.filePath, doc.title, true);
        return;
      }
    }

    return res.status(400).json({
      message: "Бұл файл түріне preview жоқ. Төмендегі батырмамен жүктеп алуға болады.",
    });
  } catch (error) {
    console.error("GET SHARED DOCUMENT ERROR:", error);
    res.status(500).json({ message: "Shared preview кезінде қате шықты" });
  } finally {
    cleanupDir(tempDirToDelete);
  }
});

router.get("/shared/:token/download", async (req, res) => {
  try {
    await poolConnect;

    const result = await pool
      .request()
      .input("token", sql.NVarChar(255), req.params.token)
      .query(`
        SELECT TOP 1 d.*, s.expires_at
        FROM shared_links s
        INNER JOIN documents d ON d.id = s.document_id
        WHERE s.token = @token AND d.deleted_at IS NULL
        ORDER BY s.id DESC
      `);

    const doc = result.recordset[0];

    if (!doc) {
      return res.status(404).json({ message: "Сілтеме табылмады" });
    }

    if (new Date(doc.expires_at) < new Date()) {
      return res.status(410).json({ message: "Сілтеменің уақыты өтіп кеткен" });
    }

    res.setHeader("X-Expires-At", new Date(doc.expires_at).toISOString());

    const readable = getReadableDocument(doc);

    if (!readable) {
      return res.status(404).json({ message: "Файл серверде табылмады" });
    }

    res.setHeader("Content-Type", doc.mime_type || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(doc.original_name || doc.filename)}"`);
    res.send(readable.buffer);
    return cleanupDir(readable.tempDir);
  } catch (error) {
    console.error("DOWNLOAD SHARED DOCUMENT ERROR:", error);
    res.status(500).json({ message: "Shared download кезінде қате шықты" });
  }
});

module.exports = router;
