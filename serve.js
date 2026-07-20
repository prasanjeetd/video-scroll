/* =====================================================================
   Local dev server WITH HTTP range-request support.

   WHY THIS EXISTS:
   Scroll-scrubbing sets video.currentTime as you scroll. Chrome will only
   let you seek a video if the server answers HTTP "Range" requests (206
   Partial Content). VS Code "Live Server" and `python -m http.server` do
   NOT support ranges, so the video's seekable range is empty and it stays
   frozen while you scroll. This tiny server does support ranges.

   RUN IT:
     node serve.js
   then open the URL it prints (default http://127.0.0.1:8080).

   Optional: node serve.js 5500     (choose a different port)
   ===================================================================== */
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const ROOT = __dirname;
const PORT = +(process.argv[2] || 8080);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.m4a': 'audio/mp4',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

http.createServer((req, res) => {
  let pathname = decodeURIComponent(url.parse(req.url).pathname);
  if (pathname === '/') pathname = '/index.html';

  // Prevent directory traversal
  const file = path.normalize(path.join(ROOT, pathname));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('403'); }

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('404 Not Found'); }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-cache');

    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (isNaN(start) || start < 0) start = 0;
      if (isNaN(end) || end >= st.size) end = st.size - 1;
      if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${st.size}`,
        'Content-Length': end - start + 1,
        'Content-Type': type,
      });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Length': st.size, 'Content-Type': type });
      fs.createReadStream(file).pipe(res);
    }
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log('\n  Cinematic dev server (range-enabled) running:');
  console.log('  →  http://127.0.0.1:' + PORT + '\n');
  console.log('  Video scrubbing needs this server. Do NOT use Live Server /');
  console.log('  python http.server — they do not support range requests.\n');
});
