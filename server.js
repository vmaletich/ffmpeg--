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

app.get("/health", (_, res) => res.json({ ok: true }));

async function headContentLength(url) {
  try {
    const r = await fetch(url, { method: "HEAD", redirect: "follow" });
    const len = r.headers.get("content-length");
    return len ? Number(len) : null;
  } catch {
    return null;
  }
}

async function downloadToTempFile(url) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-"));
  const filePath = path.join(tmpDir, "input.bin");

  const resp = await fetch(url, { redirect: "follow" });
  if (!resp.ok) throw new Error(`Download failed: ${resp.status} ${resp.statusText}`);
  if (!resp.body) throw new Error("No response body");

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

  return { filePath, tmpDir, sizeBytes: bytes };
}

async function ffprobe(filePath) {
  // выводим JSON, берём первый видеопоток
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
  try {
    const url = req.body?.url;
    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "Provide { url: string }" });
    }

    // быстрый чек размера (если есть)
    const declaredLen = await headContentLength(url);
    if (declaredLen && declaredLen > MAX_BYTES) {
      return res.status(413).json({ error: `File too large by HEAD > ${MAX_MB}MB`, size_bytes: declaredLen });
    }

    const { filePath, tmpDir, sizeBytes } = await downloadToTempFile(url);
    const meta = await ffprobe(filePath);

    // cleanup
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

    return res.json({
      duration: meta.duration,
      width: meta.width,
      height: meta.height,
      size_bytes: sizeBytes
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`probe service listening on :${PORT}`);
});
