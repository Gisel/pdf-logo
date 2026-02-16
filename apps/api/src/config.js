import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
// On Railway, root is apps/api. Locally, go up 3 levels to project root.
const repoRoot = process.env.RAILWAY_ENVIRONMENT
  ? path.resolve(currentDir, "../")  // Railway: /app/src -> /app
  : path.resolve(currentDir, "../../../");  // Local: apps/api/src -> project root
dotenv.config({ path: path.resolve(repoRoot, ".env") });
dotenv.config();

const storageRoot = process.env.STORAGE_ROOT
  ? path.resolve(repoRoot, process.env.STORAGE_ROOT)
  : path.resolve(repoRoot, ".storage");

const logoRefsDir = process.env.LOGO_REFS_DIR
  ? path.resolve(repoRoot, process.env.LOGO_REFS_DIR)
  : path.resolve(repoRoot, "samples/logo-refs");

const replacementBannerPath = process.env.REPLACEMENT_BANNER_PATH
  ? path.resolve(repoRoot, process.env.REPLACEMENT_BANNER_PATH)
  : path.resolve(repoRoot, "samples/footer-banner.png");

const formatABannerPath = process.env.FORMAT_A_BANNER_PATH
  ? path.resolve(repoRoot, process.env.FORMAT_A_BANNER_PATH)
  : replacementBannerPath;

const formatBBannerPath = process.env.FORMAT_B_BANNER_PATH
  ? path.resolve(repoRoot, process.env.FORMAT_B_BANNER_PATH)
  : path.resolve(repoRoot, "samples/footer-banner-2.png");

const formatCBannerPath = process.env.FORMAT_C_BANNER_PATH
  ? path.resolve(repoRoot, process.env.FORMAT_C_BANNER_PATH)
  : path.resolve(repoRoot, "samples/footer-banner-3.png");

export const config = {
  // API settings
  apiPort: Number(process.env.PORT || process.env.API_PORT || 3001),
  storageRoot,
  corsOrigin: process.env.CORS_ORIGIN || "http://localhost:3000",
  autoThreshold: Number(process.env.AUTO_THRESHOLD || 0.75),
  reviewThreshold: Number(process.env.REVIEW_THRESHOLD || 0.45),

  // Processor settings (merged from worker config)
  logoRefsDir,
  maxPagesPerJob: Number(process.env.MAX_PAGES_PER_JOB || 200),
  renderScale: Number(process.env.RENDER_SCALE || 1.2),
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  openaiModel: process.env.OPENAI_MODEL || "gpt-4.1-mini",
  aiMaxPagesPerJob: Number(process.env.AI_MAX_PAGES_PER_JOB || 100),
  aiMaxUsdPer100Pages: Number(process.env.AI_MAX_USD_PER_100_PAGES || 1.0),
  aiImageWidth: Number(process.env.AI_IMAGE_WIDTH || 1200),
  workerVerbose: String(process.env.WORKER_VERBOSE || "true").toLowerCase() !== "false",
  aiPageLimit: Number(process.env.AI_PAGE_LIMIT || 0),
  detectorMode: process.env.DETECTOR_MODE || "deterministic",
  matchAutoThreshold: Number(process.env.MATCH_AUTO_THRESHOLD || 0.62),
  matchReviewThreshold: Number(process.env.MATCH_REVIEW_THRESHOLD || 0.48),
  debugDrawBoxes: String(process.env.DEBUG_DRAW_BOXES || "false").toLowerCase() === "true",
  replacementBannerPath,
  forceFooterBanner: String(process.env.FORCE_FOOTER_BANNER || "false").toLowerCase() === "true",
  formatProfiles: {
    style_a: {
      bannerPath: formatABannerPath,
      footerRatio: Number(process.env.FORMAT_A_FOOTER_RATIO || 0.112),
      bannerFit: process.env.FORMAT_A_BANNER_FIT || "contain",
      fillBackground: String(process.env.FORMAT_A_FILL_BG || "true").toLowerCase() === "true",
      bottomOffsetPx: Number(process.env.FORMAT_A_BOTTOM_OFFSET_PX || 0)
    },
    style_b: {
      bannerPath: formatBBannerPath,
      footerRatio: Number(process.env.FORMAT_B_FOOTER_RATIO || 0.112),
      bannerFit: process.env.FORMAT_B_BANNER_FIT || "contain",
      fillBackground: String(process.env.FORMAT_B_FILL_BG || "true").toLowerCase() === "true",
      bottomOffsetPx: Number(process.env.FORMAT_B_BOTTOM_OFFSET_PX || 0)
    },
    style_c: {
      bannerPath: formatCBannerPath,
      footerRatio: Number(process.env.FORMAT_C_FOOTER_RATIO || 0.2402),
      bannerFit: process.env.FORMAT_C_BANNER_FIT || "cover",
      fillBackground: String(process.env.FORMAT_C_FILL_BG || "false").toLowerCase() === "true",
      bottomOffsetPx: Number(process.env.FORMAT_C_BOTTOM_OFFSET_PX || 0),
      rightOffsetPx: Number(process.env.FORMAT_C_RIGHT_OFFSET_PX || 0)
    }
  }
};
