import fs from "node:fs/promises";
import path from "node:path";

export function getPaths(storageRoot, jobId) {
  const inputDir = path.join(storageRoot, "input");
  const outputDir = path.join(storageRoot, "output");
  const auditDir = path.join(storageRoot, "audit");

  return {
    inputDir,
    outputDir,
    auditDir,
    inputPath: path.join(inputDir, `${jobId}.pdf`),
    outputPath: path.join(outputDir, `${jobId}.pdf`),
    auditPath: path.join(auditDir, `${jobId}.json`)
  };
}

export async function ensureStorageDirs(storageRoot) {
  const dirs = ["input", "output", "audit"].map((segment) => path.join(storageRoot, segment));
  await Promise.all(dirs.map((dir) => fs.mkdir(dir, { recursive: true })));
}

export async function saveUploadedFile(multipartFile, targetPath) {
  const chunks = [];
  for await (const chunk of multipartFile.file) {
    chunks.push(chunk);
  }
  await fs.writeFile(targetPath, Buffer.concat(chunks));
}
