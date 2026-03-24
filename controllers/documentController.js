const fs = require("fs");
const path = require("path");
const { convertToPdf } = require("../utils/officeConverter");

exports.viewDocument = async (req, res) => {

  try {

    const fileName = req.params.name;
    const filePath = path.join(__dirname, "..", "uploads", fileName);

    const ext = path.extname(fileName).toLowerCase();

    const officeExt = [".doc", ".docx", ".ppt", ".pptx"];

    if (ext === ".pdf") {
      return res.sendFile(filePath);
    }

    if (ext === ".jpg" || ext === ".png" || ext === ".jpeg") {
      return res.sendFile(filePath);
    }

    if (officeExt.includes(ext)) {

      const pdfPath = await convertToPdf(
        filePath,
        path.join(__dirname, "..", "temp")
      );

      return res.sendFile(pdfPath);
    }

    res.status(400).json({
      message: "Файл типі қолдау көрсетпейді"
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({
      message: "Файл ашу қатесі"
    });
  }

};