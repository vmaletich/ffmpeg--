import express from "express";
import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
// лимит на скачивание (защита от гигабайтных файлов)
const MAX_MB = Number(process.env.MAX_MB || 250);
const MAX_BYTES = MAX_MB * 1024 * 1024;

// сколько символов HTML/текста вернуть в ошибке (для диагностики)
const ERROR_SNIPPET_CHARS = Number(process.env.ERROR_SNIPPET_CHARS || 300);

const FETCH_HEADERS = {
  // иногда Drive ведёт себя лучше, если есть User-Agent
  "User-Agent": "Mozilla/5.0 (compatible; ffprobe-service/1.0)",
  "Accept": "*/*",
};

app.get("/health", (_, res) => res.json({ ok: true }));

function isLikelyBinaryOrVideo(contentType = "") {
  const ct = contentType.toLowerCase();
  return (
    ct.includes("video/") ||
    ct.includes("application/octet-stream") ||
    ct.includes("binary/octet-stream")
  );
}

function isHtml(contentType = "") {
  const ct = contentType.toLowerCase();
  return ct.includes("text/html") || ct.includes("application/xhtml+xml");
}

async function headMeta(url) {
  try {
    const r = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      headers: FETCH_HEADERS,
    });
    const len = r.headers.get("content-length");
    const ct = r.headers.get("content-type") || "";
    return {
      ok: r.ok,
      status: r.status,
      statusText: r.statusText,
      contentLength: len ? Number(len) : null,
      contentType: ct,
    };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      statusText: e?.message || "HEAD failed",
      contentLength: null,
      contentType: "",
    };
  }
}

async function downloadToTempFile(url) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-"));
  const filePath = path.join(tmpDir, "input.bin");

  const resp = await fetch(url, { redirect: "follow", headers: FETCH_HEADERS });
  if (!resp.ok) {
    throw new Error(`Download failed: ${resp.status} ${resp.statusText}`);
  }
  if (!resp.body) {
    throw new Error("No response body");
  }

  const ct = resp.headers.get("content-type") || "";
  const cl = resp.headers.get("content-length");
  const declaredLen = cl ? Number(cl) : null;

  // Если HEAD не дал size, проверим тут
  if (declaredLen && declaredLen > MAX_BYTES) {
    throw new Error(`File too large by GET content-length > ${MAX_MB}MB`);
  }

  // 🔥 КЛЮЧЕВОЕ: Drive иногда отдаёт HTML-страницу вместо mp4
  if (isHtml(ct) || (!isLikelyBinaryOrVideo(ct) && ct)) {
    // читаем немного текста, чтобы понять, что пришло
    const text = await resp.text();
    const snippet = text.slice(0, ERROR_SNIPPET_CHARS).replace(/\s+/g, " ").trim();
    throw new Error(
      `Unexpected content-type: ${ct}. First chars: ${snippet}`
    );
  }

  const ws = fs.createWriteStream(filePath);
  let bytes = 0;

  await new Promise((resolve, reject) => {
    resp.body.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) {
        reject(new Error(`File too large > ${MAX_MB}MB`));
        resp.body?.destroy?.();
        ws.destroy();
        return;
      }
    });
    resp.body.on("error", reject);
    ws.on("error", reject);
    ws.on("finish", resolve);

    resp.body.pipe(ws);
  });

  return {
    filePath,
    tmpDir,
    sizeBytes: bytes,
    contentType: ct,
    contentLength: declaredLen,
  };
}

async function ffprobe(filePath) {
  const args = [
    "-v", "error",
    "-print_format", "json",
    "-show_streams",
    "-show_format",
    filePath
  ];

  const { stdout } = await execFileAsync("ffprobe", args, { maxBuffer: 10 * 1024 * 1024 });
  const data = JSON.parse(stdout);

  const videoStream = (data.streams || []).find((s) => s.codec_type === "video");
  const format = data.format || {};

  const duration = Number(format.duration || 0);
  const width = videoStream ? Number(videoStream.width || 0) : 0;
  const height = videoStream ? Number(videoStream.height || 0) : 0;

  return { duration, width, height };
}

app.post("/probe", async (req, res) => {
  let tmpDir = null;

  try {
    const url = req.body?.url;
    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "Provide { url: string }" });
    }

    // быстрый чек размера и типа (если есть)
    const head = await headMeta(url);

    if (head.contentLength && head.contentLength > MAX_BYTES) {
      return res.status(413).json({
        error: `File too large by HEAD > ${MAX_MB}MB`,
        size_bytes: head.contentLength,
      });
    }

    // Если уже по HEAD видно html — сразу объясняем
    if (head.contentType && isHtml(head.contentType)) {
      return res.status(422).json({
        error: `URL does not look like a direct video download (HEAD content-type is HTML): ${head.contentType}`,
        hint: "Google Drive may return an HTML warning/confirm page. Use a truly direct downloadable URL or switch to Drive API alt=media.",
      });
    }

    const dl = await downloadToTempFile(url);
    tmpDir = dl.tmpDir;

    const meta = await ffprobe(dl.filePath);

    return res.json({
      duration: meta.duration,
      width: meta.width,
      height: meta.height,
      size_bytes: dl.sizeBytes,
      content_type: dl.contentType || head.contentType || "",
    });
  } catch (e) {
    return res.status(500).json({
      error: e?.message || String(e),
      hint: "If you see 'Unexpected content-type: text/html', Google Drive returned an HTML page instead of the video. Use a direct downloadable URL or implement Drive API download (alt=media).",
    });
  } finally {
    // cleanup всегда
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }
});

app.listen(PORT, () => {
  console.log(`probe service listening on :${PORT}`);
});
