const express = require('express');
const { chromium } = require('playwright');

const app = express();
const PORT = 3000;
const CAPTURE_INTERVAL_MS = 100;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

let browser = null;
let page = null;
let currentId = null;
let lastFrame = null;
let captureTimer = null;
let idleTimer = null;

async function ensureBrowser() {
  if (!browser) {
    browser = await chromium.launch({
      args: [
        '--autoplay-policy=no-user-gesture-required',
        '--disable-dev-shm-usage'
      ]
    });
  }
}

function embedHtml(id) {
  return `<!DOCTYPE html><html><body style="margin:0;background:#000">
<iframe id="yt" width="854" height="480"
  src="https://www.youtube.com/embed/${id}?autoplay=1&mute=1&controls=0&playsinline=1&modestbranding=1&iv_load_policy=3&rel=0&origin=http://localhost:${PORT}"
  frameborder="0" allow="autoplay; encrypted-media"></iframe>
</body></html>`;
}

async function loadVideo(id) {
  await ensureBrowser();
  if (page) {
    await page.close().catch(() => {});
    page = null;
  }
  page = await browser.newPage({ viewport: { width: 854, height: 480 } });
  await page.goto(`http://localhost:${PORT}/embed-page?id=${encodeURIComponent(id)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });

  const frame = page.frameLocator('#yt');
  await frame.locator('video').waitFor({ timeout: 15000 }).catch(() => {});
  // forcer la lecture au cas où l'autoplay soit bloqué
  await page.frames().find(f => f.url().includes('youtube'))
    ?.evaluate(() => { const v = document.querySelector('video'); if (v) v.play().catch(() => {}); })
    .catch(() => {});

  currentId = id;
  startCapture();
}

function startCapture() {
  if (captureTimer) clearInterval(captureTimer);
  captureTimer = setInterval(async () => {
    if (!page) return;
    try {
      lastFrame = await page.screenshot({ type: 'jpeg', quality: 60, timeout: 2000 });
    } catch (e) {
      // garder la dernière image valide
    }
  }, CAPTURE_INTERVAL_MS);
}

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(unload, IDLE_TIMEOUT_MS);
}

async function unload() {
  if (captureTimer) clearInterval(captureTimer);
  captureTimer = null;
  if (page) {
    await page.close().catch(() => {});
    page = null;
  }
  currentId = null;
  lastFrame = null;
}

app.get('/embed-page', (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).send('missing id');
  res.set('Content-Type', 'text/html');
  res.send(embedHtml(id));
});

app.post('/pause', async (req, res) => {
  const f = page?.frames().find(fr => fr.url().includes('youtube'));
  await f?.evaluate(() => { const v = document.querySelector('video'); if (v) v.pause(); }).catch(() => {});
  res.json({ ok: true });
});

app.post('/resume', async (req, res) => {
  const f = page?.frames().find(fr => fr.url().includes('youtube'));
  await f?.evaluate(() => { const v = document.querySelector('video'); if (v) v.play().catch(() => {}); }).catch(() => {});
  res.json({ ok: true });
});

app.post('/seek', async (req, res) => {
  const t = parseFloat(req.query.t);
  if (isNaN(t)) return res.status(400).json({ error: 'invalid t' });
  const f = page?.frames().find(fr => fr.url().includes('youtube'));
  await f?.evaluate((time) => { const v = document.querySelector('video'); if (v) v.currentTime = time; }, t).catch(() => {});
  res.json({ ok: true });
});

app.get('/progress', async (req, res) => {
  const f = page?.frames().find(fr => fr.url().includes('youtube'));
  if (!f) return res.json({ currentTime: 0, duration: 0, paused: true });
  try {
    const info = await f.evaluate(() => {
      const v = document.querySelector('video');
      return v ? { currentTime: v.currentTime, duration: v.duration, paused: v.paused } : { currentTime: 0, duration: 0, paused: true };
    });
    res.json(info);
  } catch (e) {
    res.json({ currentTime: 0, duration: 0, paused: true });
  }
});

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

app.get('/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'missing q' });
  try {
    let url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&hl=fr`;
    if (req.query.sort === 'date') {
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
    if (!m) return res.json([]);
    const data = JSON.parse(m[1]);
    const results = findVideoRenderers(data, []).slice(0, 24);
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post('/load', async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'missing id' });
  try {
    if (id !== currentId) {
      await loadVideo(id);
    }
    resetIdleTimer();
    res.json({ ok: true, id: currentId });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post('/unload', async (req, res) => {
  await unload();
  res.json({ ok: true });
});

app.get('/frame.jpg', (req, res) => {
  resetIdleTimer();
  if (!lastFrame) return res.status(404).send('no frame');
  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'no-store');
  res.send(lastFrame);
});

app.get('/status', (req, res) => {
  res.json({ id: currentId, hasFrame: !!lastFrame });
});

app.listen(PORT, () => console.log('ytcap listening on', PORT));
