import fs from "node:fs/promises";
import path from "node:path";

import { PDFDocument, rgb } from "pdf-lib";
import { createCanvas } from "@napi-rs/canvas";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import sharp from "sharp";

import { config } from "./config.js";

function log(...args) {
  if (config.workerVerbose) console.log("[processor]", ...args);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

const SOLID_FOOTER_COLOR = { r: 110 / 255, g: 31 / 255, b: 93 / 255 }; // #6E1F5D

function extractJsonObject(text) {
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function cleanModelJsonText(text) {
  if (!text) return "";
  return text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
}

function responseToText(json) {
  if (typeof json.output_text === "string" && json.output_text.trim()) return json.output_text;
  const chunks = [];
  const output = Array.isArray(json.output) ? json.output : [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (typeof part?.text === "string" && part.text.trim()) chunks.push(part.text);
      else if (typeof part?.output_text === "string" && part.output_text.trim()) chunks.push(part.output_text);
    }
  }
  return chunks.join("\n");
}

function parseVisionDetections(text) {
  const cleaned = cleanModelJsonText(text);
  if (!cleaned) return [];

  try {
    const data = JSON.parse(cleaned);
    if (Array.isArray(data)) return data;
    if (data && typeof data === "object") return [data];
  } catch {
    const one = extractJsonObject(cleaned);
    if (one && typeof one === "object") return [one];
  }

  // Fallback for truncated array responses: salvage complete object chunks.
  const objects = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < cleaned.length; i += 1) {
    const ch = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const chunk = cleaned.slice(start, i + 1);
        try {
          const obj = JSON.parse(chunk);
          if (obj && typeof obj === "object") objects.push(obj);
        } catch {
          // ignore malformed chunk
        }
        start = -1;
      }
    }
  }
  if (objects.length > 0) return objects;

  return [];
}

function computeEdgeMap(gray, width, height, threshold = 22) {
  const edges = new Uint8Array(width * height);
  for (let y = 0; y < height - 1; y += 1) {
    const row = y * width;
    const nextRow = (y + 1) * width;
    for (let x = 0; x < width - 1; x += 1) {
      const idx = row + x;
      const gx = Math.abs(gray[idx] - gray[idx + 1]);
      const gy = Math.abs(gray[idx] - gray[nextRow + x]);
      edges[idx] = (gx + gy) >= threshold ? 1 : 0;
    }
  }
  return edges;
}

function isPurplePixel(r, g, b) {
  return r > 55 && b > 55 && g < 120 && r > (g + 18) && b > (g + 18);
}

function detectFooterBand(raw, width, height, channels) {
  const startY = Math.floor(height * 0.45);
  const minBandHeight = Math.max(24, Math.floor(height * 0.05));
  const rowPurpleRatio = new Array(height).fill(0);

  for (let y = startY; y < height; y += 1) {
    let purpleCount = 0;
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * channels;
      const r = raw[idx];
      const g = raw[idx + 1] ?? raw[idx];
      const b = raw[idx + 2] ?? raw[idx];
      if (isPurplePixel(r, g, b)) purpleCount += 1;
    }
    rowPurpleRatio[y] = purpleCount / width;
  }

  let best = null;
  let y = startY;
  while (y < height) {
    if (rowPurpleRatio[y] < 0.28) {
      y += 1;
      continue;
    }

    const bandStart = y;
    let ratioSum = 0;
    let bandRows = 0;
    while (y < height && rowPurpleRatio[y] >= 0.2) {
      ratioSum += rowPurpleRatio[y];
      bandRows += 1;
      y += 1;
    }
    const bandEnd = y - 1;
    const bandHeight = bandEnd - bandStart + 1;
    const avgRatio = bandRows > 0 ? ratioSum / bandRows : 0;

    if (bandHeight >= minBandHeight) {
      const score = (bandHeight * 0.7) + (avgRatio * height * 0.3);
      if (!best || score > best.score) {
        best = { y0: bandStart, y1: bandEnd, score };
      }
    }
  }

  if (!best) return null;
  return {
    x0: Math.floor(width * 0.45),
    y0: best.y0,
    x1: width,
    y1: best.y1 + 1
  };
}

async function loadLogoTemplates() {
  log(`loading logo refs from ${config.logoRefsDir}`);
  const names = await fs.readdir(config.logoRefsDir);
  const files = names
    .filter((name) => /\.(png|jpg|jpeg)$/i.test(name))
    .map((name) => path.join(config.logoRefsDir, name));

  if (files.length === 0) {
    throw new Error(`No logo references found in ${config.logoRefsDir}`);
  }

  const templates = [];
  for (const file of files) {
    const trimmed = await sharp(file).rotate().trim().grayscale().toBuffer();
    const baseMeta = await sharp(trimmed).metadata();
    if (!baseMeta.width || !baseMeta.height) continue;

    for (const targetWidth of [90, 120, 150, 190, 230]) {
      const variantRaw = await sharp(trimmed)
        .resize({ width: targetWidth, fit: "inside", withoutEnlargement: false })
        .raw()
        .toBuffer({ resolveWithObject: true });

      const w = variantRaw.info.width;
      const h = variantRaw.info.height;
      if (!w || !h || w < 40 || h < 12) continue;

      const gray = new Uint8Array(variantRaw.data);
      const edges = computeEdgeMap(gray, w, h);
      let edgeCount = 0;
      for (let i = 0; i < edges.length; i += 1) edgeCount += edges[i];
      if (edgeCount < 40) continue;

      templates.push({ refName: path.basename(file), width: w, height: h, edges });
    }
  }

  if (templates.length === 0) {
    throw new Error("No usable template variants could be built");
  }

  log(`built ${templates.length} template variants`);
  return templates;
}

async function loadLogoReferenceImages() {
  const names = await fs.readdir(config.logoRefsDir);
  const files = names
    .filter((name) => /\.(png|jpg|jpeg)$/i.test(name))
    .map((name) => path.join(config.logoRefsDir, name));

  if (files.length === 0) {
    throw new Error(`No logo references found in ${config.logoRefsDir}`);
  }

  const refs = [];
  for (const file of files) {
    const resized = await sharp(file)
      .rotate()
      .resize({ width: 512, withoutEnlargement: true, fit: "inside" })
      .png()
      .toBuffer();
    refs.push({ name: path.basename(file), mimeType: "image/png", base64: resized.toString("base64") });
  }
  return refs;
}

function renderPageToPngBuffer(page, scale) {
  const viewport = page.getViewport({ scale });
  const width = Math.floor(viewport.width);
  const height = Math.floor(viewport.height);
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");

  return page
    .render({ canvasContext: context, viewport })
    .promise.then(() => ({ png: canvas.toBuffer("image/png"), width, height }));
}

function scoreTemplateAt(pageEdges, pageWidth, x, y, template) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  const tW = template.width;
  const tH = template.height;

  for (let ty = 0; ty < tH; ty += 1) {
    const pageRow = (y + ty) * pageWidth;
    const tRow = ty * tW;
    for (let tx = 0; tx < tW; tx += 1) {
      const p = pageEdges[pageRow + x + tx];
      const t = template.edges[tRow + tx];
      if (p && t) tp += 1;
      else if (p && !t) fp += 1;
      else if (!p && t) fn += 1;
    }
  }

  const denom = tp + (0.65 * fp) + (1.25 * fn);
  return denom > 0 ? tp / denom : 0;
}

function detectLogoByTemplateMatch(pageEdges, pageWidth, pageHeight, templates, searchZone) {
  let best = { score: 0, bboxPx: null, matchedReference: null };

  const zones = searchZone
    ? [searchZone]
    : [{ x0: Math.floor(pageWidth * 0.45), y0: Math.floor(pageHeight * 0.60), x1: pageWidth, y1: pageHeight }];

  for (const template of templates) {
    const tW = template.width;
    const tH = template.height;

    for (const zone of zones) {
      const maxX = zone.x1 - tW;
      const maxY = zone.y1 - tH;
      if (maxX <= zone.x0 || maxY <= zone.y0) continue;

      for (let y = zone.y0; y <= maxY; y += 3) {
        for (let x = zone.x0; x <= maxX; x += 3) {
          const score = scoreTemplateAt(pageEdges, pageWidth, x, y, template);
          if (score > best.score) {
            best = { score, bboxPx: { x, y, width: tW, height: tH }, matchedReference: template.refName };
          }
        }
      }
    }
  }

  return best;
}

function isBboxPlausible(bboxPx, pageWidth, pageHeight) {
  if (!bboxPx) return false;
  const wr = bboxPx.width / pageWidth;
  const hr = bboxPx.height / pageHeight;
  if (wr < 0.05 || wr > 0.42) return false;
  if (hr < 0.015 || hr > 0.22) return false;
  return true;
}

function imageBboxToPdfRect(bboxPx, renderSize, pageSize) {
  const x = (bboxPx.x / renderSize.width) * pageSize.width;
  const yTop = (bboxPx.y / renderSize.height) * pageSize.height;
  const width = (bboxPx.width / renderSize.width) * pageSize.width;
  const height = (bboxPx.height / renderSize.height) * pageSize.height;
  const y = pageSize.height - yTop - height;

  return {
    x: clamp(x, 0, pageSize.width),
    y: clamp(y, 0, pageSize.height),
    width: clamp(width, 1, pageSize.width),
    height: clamp(height, 1, pageSize.height)
  };
}

function getStableFooterPdfRect(pageSize, footerRatio) {
  const height = pageSize.height * footerRatio;
  return {
    x: 0,
    y: 0,
    width: pageSize.width,
    height
  };
}

function drawBannerFitted(page, bannerImage, targetRect, options) {
  const fit = options?.fit === "cover" ? "cover" : "contain";
  const fillBackground = Boolean(options?.fillBackground);
  const bgColor = options?.bgColor || SOLID_FOOTER_COLOR;
  const bottomOffsetPx = Number(options?.bottomOffsetPx || 0);

  if (fillBackground) {
    page.drawRectangle({
      x: targetRect.x,
      y: targetRect.y,
      width: targetRect.width,
      height: targetRect.height,
      color: rgb(bgColor.r, bgColor.g, bgColor.b)
    });
  }

  const size = bannerImage.scale(1);
  const imageAspect = size.width / size.height;
  const targetAspect = targetRect.width / targetRect.height;

  let drawWidth = targetRect.width;
  let drawHeight = targetRect.height;

  if (fit === "contain") {
    if (imageAspect > targetAspect) {
      drawHeight = targetRect.width / imageAspect;
    } else {
      drawWidth = targetRect.height * imageAspect;
    }
  } else {
    if (imageAspect > targetAspect) {
      drawWidth = targetRect.height * imageAspect;
    } else {
      drawHeight = targetRect.width / imageAspect;
    }
  }

  const drawX = targetRect.x + ((targetRect.width - drawWidth) / 2);
  // Positive offset moves banner down; negative offset moves it up.
  const drawY = targetRect.y + ((targetRect.height - drawHeight) / 2) - bottomOffsetPx;

  page.drawImage(bannerImage, {
    x: drawX,
    y: drawY,
    width: drawWidth,
    height: drawHeight
  });
}

async function sampleFillColor(pagePng, bboxPx) {
  const image = sharp(pagePng).removeAlpha();
  const meta = await image.metadata();
  if (!meta.width || !meta.height || !meta.channels) return { r: 1, g: 1, b: 1 };

  const channels = meta.channels;
  const raw = await image.raw().toBuffer();
  const width = meta.width;
  const height = meta.height;

  const margin = 10;
  const left = Math.floor(clamp(bboxPx.x - margin, 0, width - 1));
  const top = Math.floor(clamp(bboxPx.y - margin, 0, height - 1));
  const right = Math.floor(clamp(bboxPx.x + bboxPx.width + margin, 0, width - 1));
  const bottom = Math.floor(clamp(bboxPx.y + bboxPx.height + margin, 0, height - 1));

  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let count = 0;

  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const isBorder = x < bboxPx.x || x > (bboxPx.x + bboxPx.width) || y < bboxPx.y || y > (bboxPx.y + bboxPx.height);
      if (!isBorder) continue;
      const idx = (y * width + x) * channels;
      const r = Number(raw[idx]);
      const g = Number(raw[idx + 1] ?? raw[idx]);
      const b = Number(raw[idx + 2] ?? raw[idx]);
      if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) continue;
      sumR += r;
      sumG += g;
      sumB += b;
      count += 1;
    }
  }

  if (count === 0) return { r: 1, g: 1, b: 1 };
  return {
    r: clamp((sumR / count) / 255, 0, 1),
    g: clamp((sumG / count) / 255, 0, 1),
    b: clamp((sumB / count) / 255, 0, 1)
  };
}

async function loadReplacementBannerForPdf(pdfDoc, bannerPath) {
  try {
    const bytes = await fs.readFile(bannerPath);
    if (/\.png$/i.test(bannerPath)) {
      const img = await pdfDoc.embedPng(bytes);
      return { image: img, kind: "png" };
    }
    if (/\.jpe?g$/i.test(bannerPath)) {
      const img = await pdfDoc.embedJpg(bytes);
      return { image: img, kind: "jpg" };
    }

    // Fallback: try png then jpg.
    try {
      const img = await pdfDoc.embedPng(bytes);
      return { image: img, kind: "png" };
    } catch {
      const img = await pdfDoc.embedJpg(bytes);
      return { image: img, kind: "jpg" };
    }
  } catch (error) {
    log(`replacement banner load failed (${bannerPath}):`, error instanceof Error ? error.message : String(error));
    return null;
  }
}

async function detectLogoWithVision(pagePng, logoRefs) {
  const pageForModel = await sharp(pagePng)
    .resize({ width: config.aiImageWidth, withoutEnlargement: true, fit: "inside" })
    .png()
    .toBuffer();

  const content = [
    {
      type: "input_text",
      text:
        "Find ONLY ONE branding logo in the BOTTOM PURPLE FOOTER BAR: IDECF or Fernando Sanchez. Return ONLY a single JSON object (not an array, no markdown) with {found:boolean,confidence:number,bbox:{x:number,y:number,width:number,height:number},matchedReference:string|null}. Ignore top header/title text. Coordinates normalized 0..1."
    },
    { type: "input_text", text: "Page image:" },
    { type: "input_image", image_url: `data:image/png;base64,${pageForModel.toString("base64")}` }
  ];

  for (const ref of logoRefs) {
    content.push({ type: "input_text", text: `Reference logo: ${ref.name}` });
    content.push({ type: "input_image", image_url: `data:${ref.mimeType};base64,${ref.base64}` });
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.openaiApiKey}`
    },
    body: JSON.stringify({
      model: config.openaiModel,
      temperature: 0,
      max_output_tokens: 500,
      input: [{ role: "user", content }]
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI request failed (${response.status}): ${body.slice(0, 200)}`);
  }

  const json = await response.json();
  const text = responseToText(json);
  const candidates = parseVisionDetections(text)
    .map((item) => {
      const found = Boolean(item?.found);
      const confidence = clamp(Number(item?.confidence ?? 0), 0, 1);
      const bbox = item?.bbox
        ? {
            x: clamp(Number(item.bbox.x ?? 0), 0, 1),
            y: clamp(Number(item.bbox.y ?? 0), 0, 1),
            width: clamp(Number(item.bbox.width ?? 0), 0, 1),
            height: clamp(Number(item.bbox.height ?? 0), 0, 1)
          }
        : null;
      return {
        found,
        confidence,
        bbox,
        matchedReference: item?.matchedReference || null
      };
    })
    .filter((c) => c.found && c.bbox && c.bbox.width > 0 && c.bbox.height > 0);

  if (candidates.length === 0) {
    return { found: false, confidence: 0, bbox: null, matchedReference: null, rawText: text };
  }

  // Prefer higher confidence and farther-right detections (where your footer logos live).
  candidates.sort((a, b) => {
    const qa = a.confidence + (a.bbox.x * 0.1);
    const qb = b.confidence + (b.bbox.x * 0.1);
    return qb - qa;
  });

  const best = candidates[0];
  return {
    found: true,
    confidence: best.confidence,
    bbox: best.bbox,
    matchedReference: best.matchedReference,
    rawText: text
  };
}

function isFooterLogoBboxValid(bbox) {
  if (!bbox) return false;
  const x = Number(bbox.x ?? 0);
  const y = Number(bbox.y ?? 0);
  const w = Number(bbox.width ?? 0);
  const h = Number(bbox.height ?? 0);

  // Footer-only hard gates to block top-title false detections.
  if (y < 0.72) return false;
  // Do not require a strict x floor here; some valid footer logos can be left-shifted.
  if (w < 0.06 || w > 0.35) return false;
  if (h < 0.02 || h > 0.15) return false;
  return true;
}

function isFooterStripCandidate(bbox) {
  if (!bbox) return false;
  const y = Number(bbox.y ?? 0);
  const w = Number(bbox.width ?? 0);
  const h = Number(bbox.height ?? 0);
  return y >= 0.72 && w >= 0.55 && h >= 0.06 && h <= 0.2;
}

export async function processPdf(jobData) {
  const { inputPath, outputPath, auditPath, settings } = jobData;
  const formatKey = String(settings?.formatKey || "style_a");
  const formatProfile = config.formatProfiles[formatKey] || config.formatProfiles.style_a;

  const autoThreshold = Number(settings?.autoThreshold ?? config.matchAutoThreshold);
  const reviewThreshold = Number(settings?.reviewThreshold ?? config.matchReviewThreshold);

  log(`starting job input=${inputPath}`);
  log(`mode=${config.detectorMode} auto=${autoThreshold} review=${reviewThreshold} renderScale=${config.renderScale}`);
  if (config.debugDrawBoxes) log("debug draw mode enabled: red/orange boxes will be visible");
  if (config.forceFooterBanner) log("force footer banner mode enabled: applying banner to every page");

  const useAiDetector = config.detectorMode === "ai-probe" || config.detectorMode === "ai-cut";
  const templates = useAiDetector ? [] : await loadLogoTemplates();
  const logoRefs = useAiDetector ? await loadLogoReferenceImages() : [];

  const inputBuffer = await fs.readFile(inputPath);
  const pdfDoc = await PDFDocument.load(inputBuffer);
  const replacementBanner = config.detectorMode === "ai-cut"
    ? await loadReplacementBannerForPdf(pdfDoc, formatProfile.bannerPath)
    : null;
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(inputBuffer) });
  const renderDoc = await loadingTask.promise;

  const totalPagesInPdf = Math.min(pdfDoc.getPageCount(), renderDoc.numPages);
  const totalPages = Math.min(totalPagesInPdf, config.maxPagesPerJob, config.aiMaxPagesPerJob);
  const pagesToProcess = config.aiPageLimit > 0 ? Math.min(totalPages, config.aiPageLimit) : totalPages;

  const auditPages = [];
  log(`processing ${pagesToProcess}/${totalPagesInPdf} page(s)`);

  for (let i = 0; i < pagesToProcess; i += 1) {
    const pageNumber = i + 1;
    log(`page ${pageNumber}/${pagesToProcess}: render`);

    const renderPage = await renderDoc.getPage(pageNumber);
    const { png, width, height } = await renderPageToPngBuffer(renderPage, config.renderScale);

    let footerZone = null;
    let match = { score: 0, bboxPx: null, matchedReference: null };
    let plausible = false;
    let aiProbe = null;
    let wideFooterStrip = false;

    if (config.forceFooterBanner) {
      const rgbRaw = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      footerZone = detectFooterBand(rgbRaw.data, width, height, rgbRaw.info.channels || 3);
      const fallbackY0 = Math.floor(height * 0.885);
      const fallbackY1 = height - 1;
      const y0 = footerZone ? footerZone.y0 : fallbackY0;
      const y1 = footerZone ? footerZone.y1 : fallbackY1;

      match = {
        score: 1,
        bboxPx: {
          x: 0,
          y: y0,
          width,
          height: Math.max(1, y1 - y0)
        },
        matchedReference: "footer-banner"
      };
      plausible = true;
      wideFooterStrip = true;
      log(`page ${pageNumber}: force-banner zone=${match.bboxPx.x},${match.bboxPx.y},${match.bboxPx.width},${match.bboxPx.height}`);
    } else if (useAiDetector) {
      aiProbe = await detectLogoWithVision(png, logoRefs);
      const validFooterBox = aiProbe.found && isFooterLogoBboxValid(aiProbe.bbox);
      wideFooterStrip = aiProbe.found && isFooterStripCandidate(aiProbe.bbox);
      if (aiProbe.found && aiProbe.bbox) {
        const bboxPx = {
          x: Math.round(aiProbe.bbox.x * width),
          y: Math.round(aiProbe.bbox.y * height),
          width: Math.max(1, Math.round(aiProbe.bbox.width * width)),
          height: Math.max(1, Math.round(aiProbe.bbox.height * height))
        };
        const geometricOk = isBboxPlausible(bboxPx, width, height);
        match = {
          score: (wideFooterStrip || (validFooterBox && geometricOk)) ? aiProbe.confidence : 0,
          bboxPx,
          matchedReference: aiProbe.matchedReference
        };
        plausible = wideFooterStrip || (validFooterBox && geometricOk);
      }
      log(
        `page ${pageNumber}: ai-probe found=${aiProbe.found} confidence=${aiProbe.confidence.toFixed(3)} validFooter=${validFooterBox} wideFooterStrip=${wideFooterStrip} bbox=${aiProbe.bbox ? JSON.stringify(aiProbe.bbox) : "null"} ref=${aiProbe.matchedReference || "n/a"}`
      );
      if (aiProbe.rawText) log(`page ${pageNumber}: ai-raw=${aiProbe.rawText.slice(0, 220)}`);
    } else {
      const rgbRaw = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      footerZone = detectFooterBand(rgbRaw.data, width, height, rgbRaw.info.channels || 3);

      const pageRaw = await sharp(png).grayscale().raw().toBuffer({ resolveWithObject: true });
      const pageGray = new Uint8Array(pageRaw.data);
      const pageEdges = computeEdgeMap(pageGray, width, height);

      log(
        `page ${pageNumber}: match footerZone=${footerZone ? `${footerZone.x0},${footerZone.y0}-${footerZone.x1},${footerZone.y1}` : "none"}`
      );
      match = detectLogoByTemplateMatch(pageEdges, width, height, templates, footerZone);
      plausible = isBboxPlausible(match.bboxPx, width, height);
    }

    let action = "none";
    let pdfRect = null;
    let debugPreviewRect = null;

    if (config.detectorMode !== "ai-probe" && plausible && match.score >= autoThreshold) {
      const page = pdfDoc.getPage(i);
      const pageSize = page.getSize();
      const bannerReplacementMode = config.detectorMode === "ai-cut" && wideFooterStrip;
      pdfRect = bannerReplacementMode
        ? getStableFooterPdfRect(pageSize, formatProfile.footerRatio)
        : imageBboxToPdfRect(match.bboxPx, { width, height }, pageSize);

      let drawColor = null;
      if (config.detectorMode === "ai-cut" && wideFooterStrip) {
        drawColor = SOLID_FOOTER_COLOR;
      } else {
        const fill = await sampleFillColor(png, match.bboxPx);
        drawColor = fill;
      }
      if (config.debugDrawBoxes && !wideFooterStrip) {
        drawColor = { r: 1, g: 0, b: 0 };
      }

      if (bannerReplacementMode && replacementBanner?.image) {
        drawBannerFitted(page, replacementBanner.image, pdfRect, {
          fit: formatProfile.bannerFit,
          fillBackground: formatProfile.fillBackground,
          bgColor: SOLID_FOOTER_COLOR,
          bottomOffsetPx: formatProfile.bottomOffsetPx
        });
      } else {
        page.drawRectangle({
          x: pdfRect.x,
          y: pdfRect.y,
          width: pdfRect.width,
          height: pdfRect.height,
          color: rgb(drawColor.r, drawColor.g, drawColor.b)
        });
      }
      action = wideFooterStrip ? "replaced_footer_banner" : "removed";
    } else if (plausible && match.score >= reviewThreshold) {
      action = "review";
    }

    if (config.debugDrawBoxes && match.bboxPx && action !== "removed" && action !== "removed_footer_strip" && action !== "replaced_footer_banner") {
      const page = pdfDoc.getPage(i);
      const pageSize = page.getSize();
      debugPreviewRect = imageBboxToPdfRect(match.bboxPx, { width, height }, pageSize);
      page.drawRectangle({ x: debugPreviewRect.x, y: debugPreviewRect.y, width: debugPreviewRect.width, height: debugPreviewRect.height, borderColor: rgb(1, 0.4, 0), borderWidth: 2 });
    }

    log(`page ${pageNumber}: score=${match.score.toFixed(3)} plausible=${plausible} action=${action} ref=${match.matchedReference || "n/a"}`);

    auditPages.push({
      pageNumber,
      detectionScore: Number(match.score.toFixed(4)),
      matchedReference: match.matchedReference,
      aiProbe: aiProbe
        ? { found: aiProbe.found, confidence: aiProbe.confidence, bbox: aiProbe.bbox, rawText: aiProbe.rawText || null }
        : null,
      footerZone,
      bboxPx: match.bboxPx,
      pdfRect,
      debugPreviewRect,
      plausible,
      action
    });
  }

  const output = await pdfDoc.save();
  await fs.writeFile(outputPath, output);

  const removed = auditPages.filter((p) => p.action === "removed" || p.action === "removed_footer_strip" || p.action === "replaced_footer_banner").length;
  const review = auditPages.filter((p) => p.action === "review").length;
  const none = auditPages.length - removed - review;

  const audit = {
    mode: settings?.mode || "overlay",
    detector:
      config.detectorMode === "ai-probe"
        ? "ai-probe-v1"
        : config.detectorMode === "ai-cut"
          ? "ai-cut-v1"
          : "template-match-v2",
    formatKey,
    formatProfile,
    processedAt: new Date().toISOString(),
    thresholds: { autoThreshold, reviewThreshold },
    pages: auditPages,
    summary: {
      totalPages: pagesToProcess,
      totalPagesInPdf,
      removed,
      review,
      none,
      statusHint: review > 0 || removed === 0 ? "needs_review" : "completed"
    }
  };

  await fs.writeFile(auditPath, JSON.stringify(audit, null, 2), "utf-8");
  log(`summary removed=${removed} review=${review} none=${none}`);
  log(`wrote output=${outputPath} audit=${auditPath}`);

  return {
    pagesTotal: pagesToProcess,
    pagesProcessed: pagesToProcess,
    progress: 100,
    hasReview: review > 0 || removed === 0,
    removedCount: removed,
    reviewCount: review
  };
}
