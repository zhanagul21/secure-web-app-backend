const express = require("express");
const router = express.Router();

const multer = require("multer");
const path = require("path");
const fs = require("fs");

const { verifyToken } = require("../middleware/authMiddleware");
const { connectDB } = require("../config/db");
const { encryptFile, decryptFile } = require("../utils/encryption");
const { convertToPdf } = require("../utils/officeConverter");

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
    const safeName = Date.now() + "-" + file.originalname.replace(/\s+/g, "_");
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

// Құжат қосу
router.post("/add", verifyToken, upload.single("file"), async (req, res) => {
  try {
    const userId = req.user.id;
    const { title, category, description } = req.body;
    const db = await connectDB();

    if (!title || !category) {
      return res.status(400).json({
        message: "Құжат атауы мен категория міндетті",
      });
    }

    if (!req.file) {
      return res.status(400).json({ message: "Файл таңдалмаған" });
    }

    const originalPath = req.file.path;
    const encryptedName = req.file.filename + ".enc";
    const encryptedPath = path.join(uploadsDir, encryptedName);

    const fileBuffer = fs.readFileSync(originalPath);
    const encryptedBuffer = encryptFile(fileBuffer);
    fs.writeFileSync(encryptedPath, encryptedBuffer);

    if (fs.existsSync(originalPath)) {
      fs.unlinkSync(originalPath);
    }

    await db.query(
      `
      INSERT INTO documents (
        user_id,
        title,
        category,
        description,
        secret_content,
        original_name,
        mime_type
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        userId,
        title,
        category,
        description || "",
        encryptedName,
        req.file.originalname,
        req.file.mimetype,
      ]
    );

    await db.query(
      `
      INSERT INTO activity_logs (user_id, action_type, action_details)
      VALUES ($1, $2, $3)
      `,
      [userId, "DOCUMENT_ADD", `Құжат қосылды: ${title}`]
    );

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

// Өз құжаттарын көру
router.get("/my", verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const db = await connectDB();

    const result = await db.query(
      `
      SELECT id, title, category, description, secret_content, original_name, mime_type, created_at
      FROM documents
      WHERE user_id = $1
      ORDER BY id DESC
      `,
      [userId]
    );

    const documentsWithSize = result.rows.map((doc) => ({
      ...doc,
      file_size: getFileSize(doc.secret_content),
    }));

    res.json({ documents: documentsWithSize });
  } catch (error) {
    console.error("GET DOCUMENTS ERROR:", error);
    res.status(500).json({ message: "Құжаттарды жүктеу кезінде қате шықты" });
  }
});

// Dashboard preview
router.get("/", verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const db = await connectDB();

    const result = await db.query(
      `
      SELECT id, title, category, description, secret_content, original_name, mime_type, created_at
      FROM documents
      WHERE user_id = $1
      ORDER BY id DESC
      `,
      [userId]
    );

    const documentsWithSize = result.rows.map((doc) => ({
      ...doc,
      file_size: getFileSize(doc.secret_content),
    }));

    res.json(documentsWithSize);
  } catch (error) {
    console.error("GET DOCUMENT LIST ERROR:", error);
    res.status(500).json({ message: "Құжаттар тізімін алу кезінде қате шықты" });
  }
});

// Құжатты сайт ішінде ашу
router.get("/view/:id", verifyToken, async (req, res) => {
  let tempOriginalPath = null;
  let tempPdfPath = null;

  try {
    const userId = req.user.id;
    const documentId = parseInt(req.params.id, 10);
    const db = await connectDB();

    const result = await db.query(
      `
      SELECT *
      FROM documents
      WHERE id = $1 AND user_id = $2
      `,
      [documentId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Құжат табылмады" });
    }

    const doc = result.rows[0];

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

    const imageTypes = [".jpg", ".jpeg", ".png"];
    const officeTypes = [".doc", ".docx", ".ppt", ".pptx"];
    const txtTypes = [".txt"];

    await db.query(
      `
      INSERT INTO activity_logs (user_id, action_type, action_details)
      VALUES ($1, $2, $3)
      `,
      [userId, "DOCUMENT_VIEW", `Құжат қаралды: ${doc.title}`]
    );

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
      tempPdfPath = await convertToPdf(tempOriginalPath, tempDir);

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${encodeURIComponent(
          path.parse(originalName).name + ".pdf"
        )}"`
      );

      const stream = fs.createReadStream(tempPdfPath);
      stream.pipe(res);

      stream.on("close", () => {
        cleanupTempFile(tempOriginalPath);
        cleanupTempFile(tempPdfPath);
      });

      stream.on("error", () => {
        cleanupTempFile(tempOriginalPath);
        cleanupTempFile(tempPdfPath);
      });

      return;
    }

    cleanupTempFile(tempOriginalPath);

    return res.status(400).json({
      message: "Бұл файл түріне preview қолдау көрсетілмейді",
    });
  } catch (error) {
    console.error("VIEW DOCUMENT ERROR:", error);
    cleanupTempFile(tempOriginalPath);
    cleanupTempFile(tempPdfPath);
    res.status(500).json({ message: "Құжатты ашу кезінде қате шықты" });
  }
});

// Құжатты download ету
router.get("/download/:id", verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const documentId = parseInt(req.params.id, 10);
    const db = await connectDB();

    const result = await db.query(
      `
      SELECT *
      FROM documents
      WHERE id = $1 AND user_id = $2
      `,
      [documentId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Құжат табылмады" });
    }

    const doc = result.rows[0];

    if (!doc.secret_content) {
      return res.status(400).json({ message: "Файл жоқ" });
    }

    const encryptedPath = path.join(uploadsDir, doc.secret_content);

    if (!fs.existsSync(encryptedPath)) {
      return res.status(404).json({ message: "Шифрланған файл табылмады" });
    }

    const encryptedBuffer = fs.readFileSync(encryptedPath);
    const decryptedBuffer = decryptFile(encryptedBuffer);

    await db.query(
      `
      INSERT INTO activity_logs (user_id, action_type, action_details)
      VALUES ($1, $2, $3)
      `,
      [userId, "DOCUMENT_DOWNLOAD", `Құжат жүктелді: ${doc.title}`]
    );

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

// Құжат өшіру
router.delete("/delete/:id", verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const documentId = parseInt(req.params.id, 10);
    const db = await connectDB();

    const existing = await db.query(
      `
      SELECT *
      FROM documents
      WHERE id = $1 AND user_id = $2
      `,
      [documentId, userId]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ message: "Құжат табылмады" });
    }

    const doc = existing.rows[0];

    if (doc.secret_content) {
      const encryptedPath = path.join(uploadsDir, doc.secret_content);
      if (fs.existsSync(encryptedPath)) {
        fs.unlinkSync(encryptedPath);
      }
    }

    await db.query(
      `
      DELETE FROM documents
      WHERE id = $1 AND user_id = $2
      `,
      [documentId, userId]
    );

    await db.query(
      `
      INSERT INTO activity_logs (user_id, action_type, action_details)
      VALUES ($1, $2, $3)
      `,
      [userId, "DOCUMENT_DELETE", `Құжат өшірілді: ${doc.title}`]
    );

    res.json({ message: "Құжат өшірілді" });
  } catch (error) {
    console.error("DELETE DOCUMENT ERROR:", error);
    res.status(500).json({ message: "Құжатты өшіру кезінде қате шықты" });
  }
});

module.exports = router;