const express = require("express");
const router = express.Router();

const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const { verifyToken } = require("../middleware/authMiddleware");
const { sql } = require("../config/db");
const { encryptFile, decryptFile } = require("../utils/encryption");

const uploadsDir = path.join(__dirname, "..", "uploads");
const tempDir = path.join(__dirname, "..", "temp");

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, tempDir);
  },
  filename: function (req, file, cb) {
    const safeName = `${Date.now()}-${file.originalname.replace(/\s+/g, "_")}`;
    cb(null, safeName);
  },
});

const allowedTypes = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
];

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new Error(
          "Тек PDF, PNG, JPG, DOC, DOCX, PPT, PPTX, TXT файлдарына рұқсат"
        )
      );
    }
  },
});

function cleanupTempFile(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    console.error("TEMP FILE DELETE ERROR:", err);
  }
}

function getFileSize(secretContent) {
  try {
    if (!secretContent) return 0;

    const encryptedPath = path.join(uploadsDir, secretContent);

    if (!fs.existsSync(encryptedPath)) return 0;

    const stats = fs.statSync(encryptedPath);
    return stats.size;
  } catch (error) {
    console.error("GET FILE SIZE ERROR:", error);
    return 0;
  }
}

router.post("/add", verifyToken, upload.single("file"), async (req, res) => {
  try {
    const userId = req.user.id;
    const { title, category, description } = req.body;

    if (!title || !category) {
      return res.status(400).json({
        message: "Құжат атауы мен категория міндетті",
      });
    }

    if (!req.file) {
      return res.status(400).json({ message: "Файл таңдалмаған" });
    }

    const originalPath = req.file.path;
    const encryptedName = `${req.file.filename}.enc`;
    const encryptedPath = path.join(uploadsDir, encryptedName);

    const fileBuffer = fs.readFileSync(originalPath);
    const encryptedBuffer = encryptFile(fileBuffer);
    fs.writeFileSync(encryptedPath, encryptedBuffer);

    cleanupTempFile(originalPath);

    await sql.query`
      INSERT INTO documents (
        user_id,
        title,
        category,
        description,
        secret_content,
        original_name,
        mime_type
      )
      VALUES (
        ${userId},
        ${title},
        ${category},
        ${description || ""},
        ${encryptedName},
        ${req.file.originalname},
        ${req.file.mimetype}
      )
    `;

    await sql.query`
      INSERT INTO activity_logs (user_id, action_type, action_details)
      VALUES (${userId}, 'DOCUMENT_ADD', ${`Құжат қосылды: ${title}`})
    `;

    res.status(201).json({
      message: "Құжат сәтті жүктелді және шифрланды",
    });
  } catch (error) {
    console.error("DOCUMENT ADD ERROR:", error);
    res.status(500).json({
      message: error.message || "Құжатты жүктеу кезінде қате шықты",
    });
  }
});

router.get("/my", verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await sql.query`
      SELECT id, title, category, description, secret_content, original_name, mime_type, created_at
      FROM documents
      WHERE user_id = ${userId}
      ORDER BY id DESC
    `;

    const documentsWithSize = result.recordset.map((doc) => ({
      ...doc,
      file_size: getFileSize(doc.secret_content),
    }));

    res.json({ documents: documentsWithSize });
  } catch (error) {
    console.error("GET DOCUMENTS ERROR:", error);
    res.status(500).json({ message: "Құжаттарды жүктеу кезінде қате шықты" });
  }
});

router.get("/", verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await sql.query`
      SELECT id, title, category, description, secret_content, original_name, mime_type, created_at
      FROM documents
      WHERE user_id = ${userId}
      ORDER BY id DESC
    `;

    const documentsWithSize = result.recordset.map((doc) => ({
      ...doc,
      file_size: getFileSize(doc.secret_content),
    }));

    res.json(documentsWithSize);
  } catch (error) {
    console.error("GET DOCUMENT LIST ERROR:", error);
    res.status(500).json({ message: "Құжаттар тізімін алу кезінде қате шықты" });
  }
});

router.get("/view/:id", verifyToken, async (req, res) => {
  let tempOriginalPath = null;

  try {
    const userId = req.user.id;
    const documentId = parseInt(req.params.id, 10);

    const result = await sql.query`
      SELECT *
      FROM documents
      WHERE id = ${documentId} AND user_id = ${userId}
    `;

    if (result.recordset.length === 0) {
      return res.status(404).json({ message: "Құжат табылмады" });
    }

    const doc = result.recordset[0];

    if (!doc.secret_content) {
      return res.status(400).json({ message: "Файл жоқ" });
    }

    const encryptedPath = path.join(uploadsDir, doc.secret_content);

    if (!fs.existsSync(encryptedPath)) {
      return res.status(404).json({ message: "Шифрланған файл табылмады" });
    }

    const encryptedBuffer = fs.readFileSync(encryptedPath);
    const decryptedBuffer = decryptFile(encryptedBuffer);

    const originalName = doc.original_name || "document";
    const mimeType = doc.mime_type || "application/octet-stream";
    const ext = path.extname(originalName).toLowerCase();

    const safeFileName = `${Date.now()}-${originalName.replace(/\s+/g, "_")}`;
    tempOriginalPath = path.join(tempDir, safeFileName);
    fs.writeFileSync(tempOriginalPath, decryptedBuffer);

    const imageTypes = [".jpg", ".jpeg", ".png", ".gif", ".webp"];
    const txtTypes = [".txt"];
    const officeTypes = [".doc", ".docx", ".ppt", ".pptx"];

    await sql.query`
      INSERT INTO activity_logs (user_id, action_type, action_details)
      VALUES (${userId}, 'DOCUMENT_VIEW', ${`Құжат қаралды: ${doc.title}`})
    `;

    if (ext === ".pdf") {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${encodeURIComponent(originalName)}"`
      );

      const stream = fs.createReadStream(tempOriginalPath);
      stream.pipe(res);

      stream.on("close", () => cleanupTempFile(tempOriginalPath));
      stream.on("error", () => cleanupTempFile(tempOriginalPath));
      return;
    }

    if (imageTypes.includes(ext)) {
      res.setHeader("Content-Type", mimeType);
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${encodeURIComponent(originalName)}"`
      );

      const stream = fs.createReadStream(tempOriginalPath);
      stream.pipe(res);

      stream.on("close", () => cleanupTempFile(tempOriginalPath));
      stream.on("error", () => cleanupTempFile(tempOriginalPath));
      return;
    }

    if (txtTypes.includes(ext)) {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${encodeURIComponent(originalName)}"`
      );

      const stream = fs.createReadStream(tempOriginalPath);
      stream.pipe(res);

      stream.on("close", () => cleanupTempFile(tempOriginalPath));
      stream.on("error", () => cleanupTempFile(tempOriginalPath));
      return;
    }

    if (officeTypes.includes(ext)) {
      cleanupTempFile(tempOriginalPath);

      return res.status(400).json({
        message:
          "Office файлдарын сайт ішінде preview ету әзірге қолдау көрсетілмейді. Файлды жүктеп алып ашыңыз.",
      });
    }

    cleanupTempFile(tempOriginalPath);

    return res.status(400).json({
      message: "Бұл файл түріне preview қолдау көрсетілмейді",
    });
  } catch (error) {
    console.error("VIEW DOCUMENT ERROR:", error);
    cleanupTempFile(tempOriginalPath);
    res.status(500).json({ message: "Құжатты ашу кезінде қате шықты" });
  }
});

router.get("/download/:id", verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const documentId = parseInt(req.params.id, 10);

    const result = await sql.query`
      SELECT *
      FROM documents
      WHERE id = ${documentId} AND user_id = ${userId}
    `;

    if (result.recordset.length === 0) {
      return res.status(404).json({ message: "Құжат табылмады" });
    }

    const doc = result.recordset[0];

    if (!doc.secret_content) {
      return res.status(400).json({ message: "Файл жоқ" });
    }

    const encryptedPath = path.join(uploadsDir, doc.secret_content);

    if (!fs.existsSync(encryptedPath)) {
      return res.status(404).json({ message: "Шифрланған файл табылмады" });
    }

    const encryptedBuffer = fs.readFileSync(encryptedPath);
    const decryptedBuffer = decryptFile(encryptedBuffer);

    await sql.query`
      INSERT INTO activity_logs (user_id, action_type, action_details)
      VALUES (${userId}, 'DOCUMENT_DOWNLOAD', ${`Құжат жүктелді: ${doc.title}`})
    `;

    const fileName = doc.original_name || "document";
    const mimeType = doc.mime_type || "application/octet-stream";

    res.setHeader("Content-Type", mimeType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(fileName)}"`
    );

    res.send(decryptedBuffer);
  } catch (error) {
    console.error("DOWNLOAD DOCUMENT ERROR:", error);
    res.status(500).json({ message: "Құжатты жүктеу кезінде қате шықты" });
  }
});

router.delete("/delete/:id", verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const documentId = parseInt(req.params.id, 10);

    const existing = await sql.query`
      SELECT *
      FROM documents
      WHERE id = ${documentId} AND user_id = ${userId}
    `;

    if (existing.recordset.length === 0) {
      return res.status(404).json({ message: "Құжат табылмады" });
    }

    const doc = existing.recordset[0];

    if (doc.secret_content) {
      const encryptedPath = path.join(uploadsDir, doc.secret_content);
      if (fs.existsSync(encryptedPath)) {
        fs.unlinkSync(encryptedPath);
      }
    }

    await sql.query`
      DELETE FROM documents
      WHERE id = ${documentId} AND user_id = ${userId}
    `;

    await sql.query`
      INSERT INTO activity_logs (user_id, action_type, action_details)
      VALUES (${userId}, 'DOCUMENT_DELETE', ${`Құжат өшірілді: ${doc.title}`})
    `;

    res.json({ message: "Құжат өшірілді" });
  } catch (error) {
    console.error("DELETE DOCUMENT ERROR:", error);
    res.status(500).json({ message: "Құжатты өшіру кезінде қате шықты" });
  }
});

router.post("/share/:id", verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const documentId = parseInt(req.params.id, 10);
    const { durationMinutes } = req.body;

    const allowedDurations = [15, 60, 480, 1440];
    const expireMinutes = allowedDurations.includes(Number(durationMinutes))
      ? Number(durationMinutes)
      : 60;

    const existing = await sql.query`
      SELECT *
      FROM documents
      WHERE id = ${documentId} AND user_id = ${userId}
    `;

    if (existing.recordset.length === 0) {
      return res.status(404).json({ message: "Құжат табылмады" });
    }

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + expireMinutes * 60 * 1000);

    await sql.query`
      INSERT INTO shared_links (document_id, token, expires_at, created_by)
      VALUES (${documentId}, ${token}, ${expiresAt}, ${userId})
    `;

    const baseUrl = process.env.FRONTEND_URL || "http://localhost:5173";
    const shareUrl = `${baseUrl}/shared/${token}`;

    await sql.query`
      INSERT INTO activity_logs (user_id, action_type, action_details)
      VALUES (${userId}, 'DOCUMENT_SHARE', ${`Ссылка жасалды: ${existing.recordset[0].title}`})
    `;

    res.json({
      message: "Уақытша ссылка жасалды",
      shareUrl,
      expiresAt,
      durationMinutes: expireMinutes,
    });
  } catch (error) {
    console.error("SHARE LINK ERROR:", error);
    res.status(500).json({ message: "Ссылка жасау кезінде қате шықты" });
  }
});

router.get("/shared/:token", async (req, res) => {
  let tempOriginalPath = null;

  try {
    const { token } = req.params;

    const linkResult = await sql.query`
      SELECT sl.expires_at, d.*
      FROM shared_links sl
      INNER JOIN documents d ON sl.document_id = d.id
      WHERE sl.token = ${token}
    `;

    if (linkResult.recordset.length === 0) {
      return res.status(404).json({ message: "Ссылка табылмады" });
    }

    const doc = linkResult.recordset[0];

    if (new Date(doc.expires_at) < new Date()) {
      return res.status(410).json({ message: "Ссылка уақыты өтіп кеткен" });
    }

    if (!doc.secret_content) {
      return res.status(400).json({ message: "Файл жоқ" });
    }

    const encryptedPath = path.join(uploadsDir, doc.secret_content);

    if (!fs.existsSync(encryptedPath)) {
      return res.status(404).json({ message: "Файл табылмады" });
    }

    const encryptedBuffer = fs.readFileSync(encryptedPath);
    const decryptedBuffer = decryptFile(encryptedBuffer);

    const originalName = doc.original_name || "document";
    const mimeType = doc.mime_type || "application/octet-stream";
    const ext = path.extname(originalName).toLowerCase();

    const safeFileName = `${Date.now()}-${originalName.replace(/\s+/g, "_")}`;
    tempOriginalPath = path.join(tempDir, safeFileName);
    fs.writeFileSync(tempOriginalPath, decryptedBuffer);

    const imageTypes = [".jpg", ".jpeg", ".png", ".gif", ".webp"];
    const txtTypes = [".txt"];
    const officeTypes = [".doc", ".docx", ".ppt", ".pptx"];

    if (ext === ".pdf") {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${encodeURIComponent(originalName)}"`
      );

      const stream = fs.createReadStream(tempOriginalPath);
      stream.pipe(res);

      stream.on("close", () => cleanupTempFile(tempOriginalPath));
      stream.on("error", () => cleanupTempFile(tempOriginalPath));
      return;
    }

    if (imageTypes.includes(ext)) {
      res.setHeader("Content-Type", mimeType);
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${encodeURIComponent(originalName)}"`
      );

      const stream = fs.createReadStream(tempOriginalPath);
      stream.pipe(res);

      stream.on("close", () => cleanupTempFile(tempOriginalPath));
      stream.on("error", () => cleanupTempFile(tempOriginalPath));
      return;
    }

    if (txtTypes.includes(ext)) {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${encodeURIComponent(originalName)}"`
      );

      const stream = fs.createReadStream(tempOriginalPath);
      stream.pipe(res);

      stream.on("close", () => cleanupTempFile(tempOriginalPath));
      stream.on("error", () => cleanupTempFile(tempOriginalPath));
      return;
    }

    if (officeTypes.includes(ext)) {
      cleanupTempFile(tempOriginalPath);

      return res.status(400).json({
        message:
          "Office файлдарын ссылка арқылы preview ету әзірге қолдау көрсетілмейді. Файлды жүктеп алып ашыңыз.",
      });
    }

    cleanupTempFile(tempOriginalPath);

    return res.status(400).json({
      message: "Бұл файл түріне preview қолдау көрсетілмейді",
    });
  } catch (error) {
    console.error("SHARED VIEW ERROR:", error);
    cleanupTempFile(tempOriginalPath);
    res.status(500).json({ message: "Ссылка арқылы ашу кезінде қате шықты" });
  }
});

module.exports = router;