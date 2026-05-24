const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { sql } = require("../config/db");
const { encryptFile, decryptFile } = require("../utils/encryption");

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

// Құжат жүктеу (AES-256-GCM шифрлаумен)
const uploadDocument = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "Файл таңдалмаған" });
    }

    const userId = req.user.id;
    const { title, description } = req.body;

    // Файлды шифрлау
    const encryptedBuffer = encryptFile(req.file.buffer);

    // Шифрланған файлды уақытша сақтау
    const uploadDir = path.join(__dirname, "../uploads");
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

    const fileName = `${Date.now()}_${userId}_${req.file.originalname}.enc`;
    const filePath = path.join(uploadDir, fileName);
    fs.writeFileSync(filePath, encryptedBuffer);

    // ✅ ТҮЗЕТІЛДІ: pool.request() + .input() пайдалану керек (SQL injection болдырмау үшін)
    const { pool, poolConnect } = require("../config/db");
    await poolConnect;

    await pool
      .request()
      .input("userId", sql.Int, userId)
      .input("title", sql.NVarChar(255), title || req.file.originalname)
      .input("description", sql.NVarChar(sql.MAX), description || "")
      .input("filePath", sql.NVarChar(500), filePath)
      .input("originalName", sql.NVarChar(500), req.file.originalname)
      .input("mimeType", sql.NVarChar(255), req.file.mimetype)
      .input("size", sql.Int, req.file.size)
      .query(`
        INSERT INTO documents (user_id, title, description, file_path, original_name, mime_type, size, created_at)
        VALUES (@userId, @title, @description, @filePath, @originalName, @mimeType, @size, GETDATE())
      `);

    // Активтілік логтау
    await pool
      .request()
      .input("userId", sql.Int, userId)
      .input("action", sql.NVarChar(100), "DOCUMENT_UPLOAD")
      .input("details", sql.NVarChar(sql.MAX), `Uploaded: ${req.file.originalname}`)
      .query(`
        INSERT INTO activity_logs (user_id, action_type, action_details, created_at)
        VALUES (@userId, @action, @details, GETDATE())
      `);

    res.json({ message: "Құжат сәтті жүктелді және шифрланды" });
  } catch (error) {
    console.error("UPLOAD ERROR:", error);
    res.status(500).json({ message: "Жүктеу қатесі" });
  }
};

// Құжаттар тізімін алу
const getDocuments = async (req, res) => {
  try {
    const userId = req.user.id;
    const { pool, poolConnect } = require("../config/db");
    await poolConnect;

    const result = await pool
      .request()
      .input("userId", sql.Int, userId)
      .query(`
        SELECT id, title, description, original_name, mime_type, size, created_at
        FROM documents
        WHERE user_id = @userId
        ORDER BY created_at DESC
      `);

    res.json(result.recordset);
  } catch (error) {
    console.error("GET DOCUMENTS ERROR:", error);
    res.status(500).json({ message: "Қате" });
  }
};

// Құжатты жүктеп алу (дешифрлаумен)
const downloadDocument = async (req, res) => {
  try {
    const docId = req.params.id;
    const userId = req.user.id;
    const { pool, poolConnect } = require("../config/db");
    await poolConnect;

    // ✅ ТҮЗЕТІЛДІ: parameterized query
    const result = await pool
      .request()
      .input("docId", sql.Int, parseInt(docId, 10))
      .input("userId", sql.Int, userId)
      .query(`
        SELECT TOP 1 * FROM documents WHERE id = @docId AND user_id = @userId
      `);

    const doc = result.recordset[0];
    if (!doc) {
      return res.status(404).json({ message: "Құжат табылмады" });
    }

    // Шифрланған файлды оқу
    const encryptedBuffer = fs.readFileSync(doc.file_path);

    // Дешифрлау
    const decryptedBuffer = decryptFile(encryptedBuffer);

    // Жүктеп алу үшін жіберу
    res.setHeader("Content-Type", doc.mime_type);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(doc.original_name)}"`
    );
    res.send(decryptedBuffer);

    // Логтау (response жібергеннен кейін)
    pool
      .request()
      .input("userId", sql.Int, userId)
      .input("action", sql.NVarChar(100), "DOCUMENT_DOWNLOAD")
      .input("details", sql.NVarChar(sql.MAX), `Downloaded: ${doc.original_name}`)
      .query(`
        INSERT INTO activity_logs (user_id, action_type, action_details, created_at)
        VALUES (@userId, @action, @details, GETDATE())
      `)
      .catch((err) => console.error("LOG ERROR:", err));
  } catch (error) {
    console.error("DOWNLOAD ERROR:", error);
    res.status(500).json({ message: "Қате" });
  }
};

// Құжатты жою
const deleteDocument = async (req, res) => {
  try {
    const docId = req.params.id;
    const userId = req.user.id;
    const { pool, poolConnect } = require("../config/db");
    await poolConnect;

    // ✅ ТҮЗЕТІЛДІ: parameterized query
    const result = await pool
      .request()
      .input("docId", sql.Int, parseInt(docId, 10))
      .input("userId", sql.Int, userId)
      .query(`
        SELECT TOP 1 file_path, original_name FROM documents WHERE id = @docId AND user_id = @userId
      `);

    const doc = result.recordset[0];
    if (!doc) {
      return res.status(404).json({ message: "Құжат табылмады" });
    }

    // Файлды жою
    if (fs.existsSync(doc.file_path)) {
      fs.unlinkSync(doc.file_path);
    }

    // Дерекқордан жою
    await pool
      .request()
      .input("docId", sql.Int, parseInt(docId, 10))
      .query(`DELETE FROM documents WHERE id = @docId`);

    // Логтау
    await pool
      .request()
      .input("userId", sql.Int, userId)
      .input("action", sql.NVarChar(100), "DOCUMENT_DELETE")
      .input("details", sql.NVarChar(sql.MAX), `Deleted: ${doc.original_name}`)
      .query(`
        INSERT INTO activity_logs (user_id, action_type, action_details, created_at)
        VALUES (@userId, @action, @details, GETDATE())
      `);

    res.json({ message: "Құжат жойылды" });
  } catch (error) {
    console.error("DELETE ERROR:", error);
    res.status(500).json({ message: "Қате" });
  }
};

module.exports = {
  upload: upload.single("file"),
  uploadDocument,
  getDocuments,
  downloadDocument,
  deleteDocument,
};