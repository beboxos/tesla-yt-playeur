const express = require('express');
const { spawn, execFile } = require('child_process');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const app = express();
const PORT = 3000;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const CAPTURE_FPS = 10;
const YTDLP_BIN = process.env.YTDLP_BIN || 'yt-dlp';

let currentId = null;
let videoTitle = null;
let videoDuration = 0;
let audioUrl = null;
let videoUrl = null;
let ffmpegProc = null;
let lastFrame = null;
let jpegQuality = 60;
let captureOffset = 0;
let captureStartWall = 0;
let paused = false;
let idleTimer = null;

// L'échelle client (10-80, "plus haut = meilleur") est convertie vers
// l'échelle ffmpeg -q:v (2-31, "plus bas = meilleur").
function qualityToFfmpeg(q) {
  const clamped = Math.max(10, Math.min(80, q));
  return Math.round(31 - ((clamped - 10) / 70) * 29);
}

function currentOffset() {
  if (paused || !ffmpegProc) return captureOffset;
  return captureOffset + (Date.now() - captureStartWall) / 1000;
}

function stopCapture() {
  if (ffmpegProc) {
    ffmpegProc.kill('SIGKILL');
    ffmpegProc = null;
  }
}

function startCapture(offsetSec) {
  stopCapture();
  captureOffset = Math.max(0, offsetSec);
  captureStartWall = Date.now();
  if (!videoUrl) return;
  const qv = qualityToFfmpeg(jpegQuality);
  const args = [
    '-re',
    '-ss', String(captureOffset),
    '-i', videoUrl,
    '-an',
    '-vf', `fps=${CAPTURE_FPS}`,
    '-q:v', String(qv),
    '-f', 'image2pipe',
    '-vcodec', 'mjpeg',
    'pipe:1'
  ];
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
  let buf = Buffer.alloc(0);
  proc.stdout.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      const start = buf.indexOf(Buffer.from([0xff, 0xd8]));
      if (start === -1) { buf = Buffer.alloc(0); break; }
      const end = buf.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
      if (end === -1) {
        if (start > 0) buf = buf.slice(start);
        break;
      }
      lastFrame = buf.slice(start, end + 2);
      buf = buf.slice(end + 2);
    }
  });
  proc.on('exit', () => { if (ffmpegProc === proc) ffmpegProc = null; });
  proc.on('error', () => { if (ffmpegProc === proc) ffmpegProc = null; });
  ffmpegProc = proc;
}

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(unload, IDLE_TIMEOUT_MS);
}

function unload() {
  stopCapture();
  currentId = null;
  videoTitle = null;
  videoDuration = 0;
  audioUrl = null;
  videoUrl = null;
  lastFrame = null;
  captureOffset = 0;
  paused = false;
}

// yt-dlp résout des URLs googlevideo via différents "clients" internes
// (android_vr, web, visionos, ...). Selon le client, YouTube autorise ou
// bloque (403) l'accès direct à l'URL, et cela peut varier d'une vidéo à
// l'autre. On ne peut pas savoir à l'avance quel client fonctionnera : on
// teste donc chaque URL candidate avec une petite requête avant de la
// retenir, en préférant d'abord un flux progressif (audio+vidéo dans le
// même fichier), puis en repli des flux audio-only / video-only séparés.
function validateUrl(urlStr, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(urlStr);
    } catch (e) {
      return resolve(false);
    }
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.get(target, { headers: { Range: 'bytes=0-1' }, timeout: timeoutMs }, (res) => {
      res.destroy();
      resolve(res.statusCode === 200 || res.statusCode === 206);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

async function firstValid(formats) {
  for (const f of formats) {
    if (f.url && await validateUrl(f.url)) return f.url;
  }
  return null;
}

// Quand une vidéo propose plusieurs pistes audio (doublages), on préfère le
// français s'il est disponible plutôt que de laisser yt-dlp choisir (qui
// renvoie souvent l'anglais ou la langue "originale" en premier).
function isFrench(f) {
  return typeof f.language === 'string' && f.language.toLowerCase().startsWith('fr');
}

async function pickStreams(info) {
  const https_ = (info.formats || []).filter(f => f.protocol === 'https' && f.url);

  const muxed = https_
    .filter(f => f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none')
    .sort((a, b) => (isFrench(b) - isFrench(a)) || (b.height || 0) - (a.height || 0));
  const muxedCapped = muxed.filter(f => (f.height || 0) <= 480);
  const muxedUrl = await firstValid([...muxedCapped, ...muxed.filter(f => !muxedCapped.includes(f))]);
  if (muxedUrl) return { audioUrl: muxedUrl, videoUrl: muxedUrl };

  const audioCandidates = https_
    .filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
    .sort((a, b) => (isFrench(b) - isFrench(a)) || (b.abr || 0) - (a.abr || 0));
  const videoCandidates = https_
    .filter(f => f.vcodec && f.vcodec !== 'none' && (!f.acodec || f.acodec === 'none'));
  const videoCapped = videoCandidates.filter(f => (f.height || 0) <= 480)
    .sort((a, b) => (b.height || 0) - (a.height || 0));
  const videoRest = videoCandidates.filter(f => !videoCapped.includes(f))
    .sort((a, b) => (a.height || 0) - (b.height || 0));

  const [audioUrl, videoUrl] = await Promise.all([
    firstValid(audioCandidates),
    firstValid([...videoCapped, ...videoRest])
  ]);
  return { audioUrl, videoUrl };
}

function resolveVideo(id) {
  return new Promise((resolve, reject) => {
    execFile(YTDLP_BIN, [
      '-j', '--no-warnings',
      '--js-runtimes', 'deno',
      `https://www.youtube.com/watch?v=${id}`
    ], { maxBuffer: 1024 * 1024 * 20, timeout: 30000 },
      (err, stdout) => {
        if (err) return reject(err);
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(e);
        }
      });
  });
}

function findVideoRenderers(obj, results) {
  if (!obj || typeof obj !== 'object') return results;
  if (obj.videoRenderer) {
    const vr = obj.videoRenderer;
    const id = vr.videoId;
    const title = vr.title?.runs?.[0]?.text || vr.title?.simpleText;
    const thumbs = vr.thumbnail?.thumbnails;
    const thumb = thumbs && thumbs.length ? thumbs[thumbs.length - 1].url : null;
    const channel = vr.ownerText?.runs?.[0]?.text || vr.longBylineText?.runs?.[0]?.text;
    const duration = vr.lengthText?.simpleText;
    const published = vr.publishedTimeText?.simpleText;
    if (id && title) results.push({ id, title, thumb, channel, duration, published });
  }
  for (const k of Object.keys(obj)) {
    findVideoRenderers(obj[k], results);
  }
  return results;
}

const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const searchCache = new Map();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchSearchResults(q, sort) {
  let url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&hl=fr`;
  if (sort === 'date') {
    url += '&sp=CAI%3D';
  }
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Accept-Language': 'fr-FR,fr;q=0.9'
    }
  });
  const html = await r.text();
  const m = html.match(/var ytInitialData\s*=\s*(\{.*?\});<\/script>/s);
  if (!m) return [];
  const data = JSON.parse(m[1]);
  return findVideoRenderers(data, []).slice(0, 24);
}

app.get('/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'missing q' });
  const sort = req.query.sort === 'date' ? 'date' : '';
  const cacheKey = sort + '|' + q;
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.time < SEARCH_CACHE_TTL_MS) {
    return res.json(cached.data);
  }
  // YouTube renvoie parfois une réponse tronquée/vide sous charge (scraping
  // concurrent) ; on retente avant d'abandonner.
  const attempts = 3;
  let lastError = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const results = await fetchSearchResults(q, sort);
      searchCache.set(cacheKey, { time: Date.now(), data: results });
      return res.json(results);
    } catch (e) {
      lastError = e;
      if (i < attempts - 1) await sleep(400 * (i + 1));
    }
  }
  try {
    throw lastError;
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post('/load', async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'missing id' });
  try {
    if (id !== currentId) {
      unload();
      const info = await resolveVideo(id);
      const picked = await pickStreams(info);
      if (!picked.audioUrl && !picked.videoUrl) throw new Error('aucun flux jouable trouvé');
      currentId = id;
      videoTitle = info.title || id;
      videoDuration = info.duration || 0;
      audioUrl = picked.audioUrl;
      videoUrl = picked.videoUrl || picked.audioUrl;
      startCapture(0);
    }
    resetIdleTimer();
    res.json({ ok: true, id: currentId, title: videoTitle, duration: videoDuration });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post('/unload', (req, res) => {
  unload();
  res.json({ ok: true });
});

app.post('/pause', (req, res) => {
  captureOffset = currentOffset();
  paused = true;
  stopCapture();
  res.json({ ok: true });
});

app.post('/resume', (req, res) => {
  paused = false;
  startCapture(captureOffset);
  res.json({ ok: true });
});

app.post('/seek', (req, res) => {
  const t = parseFloat(req.query.t);
  if (isNaN(t)) return res.status(400).json({ error: 'invalid t' });
  if (paused) {
    captureOffset = t;
  } else {
    startCapture(t);
  }
  res.json({ ok: true });
});

app.post('/quality', (req, res) => {
  const q = parseInt(req.query.q, 10);
  if (isNaN(q) || q < 10 || q > 90) return res.status(400).json({ error: 'invalid q' });
  jpegQuality = q;
  if (ffmpegProc && !paused) startCapture(currentOffset());
  res.json({ ok: true, quality: jpegQuality });
});

app.get('/frame.jpg', (req, res) => {
  resetIdleTimer();
  if (!lastFrame) return res.status(404).send('no frame');
  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'no-store');
  res.send(lastFrame);
});

app.get('/status', (req, res) => {
  res.json({ id: currentId, hasFrame: !!lastFrame, duration: videoDuration, title: videoTitle });
});

app.get('/audio', (req, res) => {
  if (!audioUrl) return res.status(404).end();
  let target;
  try {
    target = new URL(audioUrl);
  } catch (e) {
    return res.status(500).end();
  }
  const lib = target.protocol === 'https:' ? https : http;
  const headers = {};
  if (req.headers.range) headers['Range'] = req.headers.range;
  const proxyReq = lib.get(target, { headers }, (proxyRes) => {
    res.status(proxyRes.statusCode);
    for (const k of ['content-length', 'content-type', 'content-range', 'accept-ranges']) {
      if (proxyRes.headers[k]) res.set(k, proxyRes.headers[k]);
    }
    proxyRes.pipe(res);
  });
  proxyReq.on('error', () => res.status(502).end());
});

app.listen(PORT, () => console.log('ytcap listening on', PORT));
