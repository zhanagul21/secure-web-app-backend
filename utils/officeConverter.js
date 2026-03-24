const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");

const sofficePath = "C:\\Program Files\\LibreOffice\\program\\soffice.exe";

function convertToPdf(inputPath, outputDir) {
  return new Promise((resolve, reject) => {
    execFile(
      sofficePath,
      [
        "--headless",
        "--convert-to",
        "pdf",
        "--outdir",
        outputDir,
        inputPath,
      ],
      (error, stdout, stderr) => {
        if (error) {
          console.error("LibreOffice convert error:", error);
          console.error("stderr:", stderr);
          return reject(error);
        }

        const baseName = path.basename(inputPath, path.extname(inputPath));
        const outputPdfPath = path.join(outputDir, `${baseName}.pdf`);

        if (!fs.existsSync(outputPdfPath)) {
          return reject(new Error("PDF файл жасалмады"));
        }

        resolve(outputPdfPath);
      }
    );
  });
}

module.exports = { convertToPdf };