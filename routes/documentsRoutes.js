const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const mammoth = require("mammoth");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { sql, pool, poolConnect } = require("../config/db");
const { encryptFile, decryptFile, isEncryptedFile } = require("../utils/encryption");

const execFileAsync = promisify(execFile);

const uploadsDir = path.resolve(process.env.UPLOADS_DIR || "./uploads");
const storeFilesInDatabase =
  Boolean(process.env.DATABASE_URL) && process.env.DB_DRIVER !== "mssql";
const configuredUploadSizeMb = Number.parseInt(
  process.env.MAX_UPLOAD_SIZE_MB || "100",
  10
);
const maxUploadSizeMb =
  Number.isFinite(configuredUploadSizeMb) && configuredUploadSizeMb > 0
    ? configuredUploadSizeMb
    : 100;
const maxUploadSizeBytes = maxUploadSizeMb * 1024 * 1024;
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
    const safeOriginalName = file.originalname.replace(/[^\w.\-() ]/g, "_");
    cb(null, `${Date.now()}-${safeOriginalName}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: maxUploadSizeBytes },
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

const authMiddleware = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ message: "Токен жоқ" });
    }

    const token = authHeader.split(" ")[1];
    req.user = jwt.verify(token, process.env.JWT_SECRET);
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

const convertDocToDocx = async (inputPath) => {
  const soffice = getLibreOfficeExecutable();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "authguard-doc-"));

  await execFileAsync(soffice, [
    "--headless",
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
      WHERE id = @documentId AND user_id = @userId
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
      WHERE id = @documentId AND user_id = @userId
    `);

  return result.recordset[0];
};

const writeTempDocumentFile = (doc, buffer) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "authguard-preview-"));
  const safeOriginalName = path.basename(doc.original_name || doc.filename || "document");
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

const getReadableDocument = (doc) => {
  if (doc.file_data) {
    const storedBuffer = Buffer.isBuffer(doc.file_data)
      ? doc.file_data
      : Buffer.from(doc.file_data);
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

  const storedBuffer = fs.readFileSync(filePath);

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
        WHERE user_id = @userId
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
    await encryptUploadedFile(req.file);
    return next();
  } catch (error) {
    console.error("ENCRYPT UPLOAD ERROR:", error);
    return res.status(500).json({
      message: "Файлды шифрлау кезінде қате шықты.",
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

    const addRequest = pool
      .request()
      .input("userId", sql.Int, req.user.id)
      .input("title", sql.NVarChar(255), title.trim())
      .input("category", sql.NVarChar(255), category.trim())
      .input("description", sql.NVarChar(sql.MAX), description || "")
      .input("filename", sql.NVarChar(500), req.file.filename)
      .input("originalName", sql.NVarChar(500), req.file.originalname)
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

    if (
      doc.mime_type ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      );
      return res.send(readable.buffer);
    }

    if (doc.mime_type === "application/msword") {
      try {
        const { convertedPath, tempDir } = await convertDocToDocx(readable.filePath);
        cleanupDir(tempDirToDelete);
        tempDirToDelete = tempDir;

        const result = await mammoth.convertToHtml({ path: convertedPath });

        return res.send(`
          <html>
            <head>
              <meta charset="UTF-8" />
              <title>${doc.original_name}</title>
              <style>
                body {
                  font-family: Arial, sans-serif;
                  padding: 24px;
                  line-height: 1.6;
                  max-width: 900px;
                  margin: 0 auto;
                  background: #fff;
                  color: #111;
                }
                img { max-width: 100%; }
                table { border-collapse: collapse; width: 100%; }
                td, th { border: 1px solid #ccc; padding: 8px; }
              </style>
            </head>
            <body>${result.value}</body>
          </html>
        `);
      } catch (error) {
        return res.status(400).json({
          message: "DOC preview үшін LibreOffice керек. DOCX/PDF қолданған дұрыс.",
        });
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
        WHERE s.token = @token
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

    if (
      doc.mime_type ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      );
      return res.send(readable.buffer);
    }

    if (doc.mime_type === "application/msword") {
      try {
        const { convertedPath, tempDir } = await convertDocToDocx(readable.filePath);
        cleanupDir(tempDirToDelete);
        tempDirToDelete = tempDir;

        const resultHtml = await mammoth.convertToHtml({ path: convertedPath });

        return res.send(`
          <html>
            <head>
              <meta charset="UTF-8" />
              <title>${doc.original_name}</title>
              <style>
                body {
                  font-family: Arial, sans-serif;
                  padding: 24px;
                  line-height: 1.6;
                  max-width: 900px;
                  margin: 0 auto;
                  background: #fff;
                  color: #111;
                }
                img { max-width: 100%; }
                table { border-collapse: collapse; width: 100%; }
                td, th { border: 1px solid #ccc; padding: 8px; }
              </style>
            </head>
            <body>${resultHtml.value}</body>
          </html>
        `);
      } catch (error) {
        return res.status(400).json({
          message: "DOC preview үшін LibreOffice керек. DOCX/PDF қолданған дұрыс.",
        });
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
        WHERE s.token = @token
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
