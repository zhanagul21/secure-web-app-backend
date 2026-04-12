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

const execFileAsync = promisify(execFile);

const uploadsDir = path.resolve(process.env.UPLOADS_DIR || "./uploads");

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});

const upload = multer({ storage });

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
  if (process.env.LIBREOFFICE_PATH) {
    return process.env.LIBREOFFICE_PATH;
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
        INSERT INTO activity_logs (user_id, action_type, action_details)
        VALUES (@userId, @actionType, @actionDetails)
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

router.get("/my", authMiddleware, async (req, res) => {
  try {
    await poolConnect;

    const result = await pool
      .request()
      .input("userId", sql.Int, req.user.id)
      .query(`
        SELECT *
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

router.post("/add", authMiddleware, upload.single("file"), async (req, res) => {
  try {
    const { title, category, description } = req.body;

    if (!title?.trim() || !category?.trim()) {
      return res.status(400).json({ message: "Құжат атауы мен категория міндетті" });
    }

    if (!req.file) {
      return res.status(400).json({ message: "Файл таңдалмаған" });
    }

    await poolConnect;

    const result = await pool
      .request()
      .input("userId", sql.Int, req.user.id)
      .input("title", sql.NVarChar(255), title.trim())
      .input("category", sql.NVarChar(255), category.trim())
      .input("description", sql.NVarChar(sql.MAX), description || "")
      .input("filename", sql.NVarChar(500), req.file.filename)
      .input("originalName", sql.NVarChar(500), req.file.originalname)
      .input("mimeType", sql.NVarChar(255), req.file.mimetype)
      .input("fileSize", sql.Int, req.file.size)
      .query(`
        INSERT INTO documents (
          user_id, title, category, description, filename, original_name, mime_type, file_size
        )
        OUTPUT INSERTED.*
        VALUES (
          @userId, @title, @category, @description, @filename, @originalName, @mimeType, @fileSize
        )
      `);

    await writeLog(req.user.id, "DOCUMENT_ADD", `Құжат қосылды: ${title.trim()}`);

    res.json({
      message: "Құжат сәтті жүктелді",
      document: result.recordset[0],
    });
  } catch (error) {
    console.error("ADD DOCUMENT ERROR:", error);
    res.status(500).json({ message: "Құжат жүктеу кезінде қате шықты" });
  }
});

router.get("/view/:id", authMiddleware, async (req, res) => {
  try {
    const doc = await getDocumentByIdForUser(req.params.id, req.user.id);

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

    const filePath = path.join(uploadsDir, doc.filename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ message: "Файл серверде табылмады" });
    }

    if (doc.mime_type === "application/pdf") {
      res.setHeader("Content-Type", "application/pdf");
      return res.sendFile(filePath);
    }

    if (doc.mime_type?.startsWith("image/")) {
      res.setHeader("Content-Type", doc.mime_type);
      return res.sendFile(filePath);
    }

    if (doc.mime_type === "text/plain") {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      return res.sendFile(filePath);
    }

    if (
      doc.mime_type ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      );
      return res.sendFile(filePath);
    }

    if (doc.mime_type === "application/msword") {
      const { convertedPath, tempDir } = await convertDocToDocx(filePath);
      tempDirToDelete = tempDir;

      const buffer = fs.readFileSync(convertedPath);

      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      );
      return res.send(buffer);
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

    const filePath = path.join(uploadsDir, doc.filename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ message: "Файл серверде табылмады" });
    }

    return res.download(filePath, doc.original_name);
  } catch (error) {
    console.error("DOWNLOAD DOCUMENT ERROR:", error);
    return res.status(500).json({ message: "Құжатты жүктеу кезінде қате шықты" });
  }
});

router.delete("/delete/:id", authMiddleware, async (req, res) => {
  try {
    const doc = await getDocumentByIdForUser(req.params.id, req.user.id);

    if (!doc) {
      return res.status(404).json({ message: "Құжат табылмады" });
    }

    const filePath = path.join(uploadsDir, doc.filename);

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    await poolConnect;
    await pool
      .request()
      .input("documentId", sql.Int, parseInt(req.params.id, 10))
      .input("userId", sql.Int, req.user.id)
      .query(`
        DELETE FROM documents
        WHERE id = @documentId AND user_id = @userId
      `);

    await writeLog(req.user.id, "DOCUMENT_DELETE", `Құжат өшірілді: ${doc.title}`);

    res.json({ message: "Құжат сәтті өшірілді" });
  } catch (error) {
    console.error("DELETE DOCUMENT ERROR:", error);
    res.status(500).json({ message: "Құжатты өшіру кезінде қате шықты" });
  }
});

router.post("/share/:id", authMiddleware, async (req, res) => {
  try {
    const { durationMinutes = 60 } = req.body;
    const doc = await getDocumentByIdForUser(req.params.id, req.user.id);

    if (!doc) {
      return res.status(404).json({ message: "Құжат табылмады" });
    }

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + Number(durationMinutes) * 60 * 1000);

    await poolConnect;
    await pool
      .request()
      .input("documentId", sql.Int, doc.id)
      .input("token", sql.NVarChar(255), token)
      .input("expiresAt", sql.DateTime, expiresAt)
      .query(`
        INSERT INTO shared_links (document_id, token, expires_at)
        VALUES (@documentId, @token, @expiresAt)
      `);

    await writeLog(req.user.id, "DOCUMENT_SHARE", `Құжатқа сілтеме жасалды: ${doc.title}`);

    const shareUrl = `${process.env.FRONTEND_URL}/shared/${token}`;

    res.json({
      message: "Сілтеме сәтті жасалды",
      shareUrl,
      expiresAt,
    });
  } catch (error) {
    console.error("SHARE DOCUMENT ERROR:", error);
    res.status(500).json({ message: "Сілтеме жасау кезінде қате шықты" });
  }
});

router.get("/shared/:token", async (req, res) => {
  try {
    await poolConnect;

    const result = await pool
      .request()
      .input("token", sql.NVarChar(255), req.params.token)
      .query(`
        SELECT TOP 1 d.*, s.expires_at
        FROM shared_links s
        JOIN documents d ON d.id = s.document_id
        WHERE s.token = @token
      `);

    const doc = result.recordset[0];

    if (!doc) {
      return res.status(404).json({ message: "Сілтеме табылмады" });
    }

    if (new Date(doc.expires_at) < new Date()) {
      return res.status(410).json({ message: "Сілтеменің уақыты өтіп кеткен" });
    }

    const filePath = path.join(uploadsDir, doc.filename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ message: "Файл серверде табылмады" });
    }

    return res.sendFile(filePath);
  } catch (error) {
    console.error("GET SHARED DOCUMENT ERROR:", error);
    res.status(500).json({ message: "Ортақ құжатты ашу кезінде қате шықты" });
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
        JOIN documents d ON d.id = s.document_id
        WHERE s.token = @token
      `);

    const doc = result.recordset[0];

    if (!doc) {
      return res.status(404).json({ message: "Сілтеме табылмады" });
    }

    if (new Date(doc.expires_at) < new Date()) {
      return res.status(410).json({ message: "Сілтеменің уақыты өтіп кеткен" });
    }

    const filePath = path.join(uploadsDir, doc.filename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ message: "Файл серверде табылмады" });
    }

    return res.download(filePath, doc.original_name);
  } catch (error) {
    console.error("DOWNLOAD SHARED DOCUMENT ERROR:", error);
    res.status(500).json({ message: "Ортақ файлды жүктеу кезінде қате шықты" });
  }
});

module.exports = router;