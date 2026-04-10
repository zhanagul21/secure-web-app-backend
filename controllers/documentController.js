const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { sql } = require("../config/db");
const { encryptFile, decryptFile } = require("../utils/encryption");
const { authMiddleware } = require("../middleware/authMiddleware");

const storage = multer.memoryStorage();
const upload = multer({ 
  storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
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
    
    // Дерекқорға сақтау
    await sql.query`
      INSERT INTO documents (user_id, title, description, file_path, original_name, mime_type, size, created_at)
      VALUES (${userId}, ${title || req.file.originalname}, ${description || ""}, ${filePath}, ${req.file.originalname}, ${req.file.mimetype}, ${req.file.size}, GETDATE())
    `;
    
    // Активтілік логтау
    await sql.query`
      INSERT INTO activity_logs (user_id, action, details, created_at)
      VALUES (${userId}, "DOCUMENT_UPLOAD", ${`Uploaded: ${req.file.originalname}`}, GETDATE())
    `;
    
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
    
    const result = await sql.query`
      SELECT id, title, description, original_name, mime_type, size, created_at
      FROM documents
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
    `;
    
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
    
    const result = await sql.query`
      SELECT * FROM documents WHERE id = ${docId} AND user_id = ${userId}
    `;
    
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
    res.setHeader("Content-Disposition", `attachment; filename="${doc.original_name}"`);
    res.send(decryptedBuffer);
    
    // Логтау
    await sql.query`
      INSERT INTO activity_logs (user_id, action, details, created_at)
      VALUES (${userId}, "DOCUMENT_DOWNLOAD", ${`Downloaded: ${doc.original_name}`}, GETDATE())
    `;
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
    
    const result = await sql.query`
      SELECT file_path FROM documents WHERE id = ${docId} AND user_id = ${userId}
    `;
    
    const doc = result.recordset[0];
    if (!doc) {
      return res.status(404).json({ message: "Құжат табылмады" });
    }
    
    // Файлды жою
    if (fs.existsSync(doc.file_path)) {
      fs.unlinkSync(doc.file_path);
    }
    
    // Дерекқордан жою
    await sql.query`DELETE FROM documents WHERE id = ${docId}`;
    
    // Логтау
    await sql.query`
      INSERT INTO activity_logs (user_id, action, details, created_at)
      VALUES (${userId}, "DOCUMENT_DELETE", ${`Deleted: ${doc.original_name}`}, GETDATE())
    `;
    
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
  deleteDocument
};