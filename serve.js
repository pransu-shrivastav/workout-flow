/**
 * Zero-dependency local dev server — no npm install required.
 * Usage: node serve.js
 * Opens: http://localhost:3000
 */

import http from 'http';
import fs   from 'fs';
import path from 'path';
import url  from 'url';

const PORT = 3000;
const ROOT = path.dirname(url.fileURLToPath(import.meta.url));

const MIME = {
  '.html':        'text/html; charset=utf-8',
  '.js':          'application/javascript; charset=utf-8',
  '.mjs':         'application/javascript; charset=utf-8',
  '.css':         'text/css; charset=utf-8',
  '.json':        'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png':         'image/png',
  '.ico':         'image/x-icon',
  '.svg':         'image/svg+xml',
  '.woff2':       'font/woff2',
  '.woff':        'font/woff',
  '.txt':         'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
  let pathname = new URL(req.url, `http://localhost:${PORT}`).pathname;

  // Default to index.html
  if (pathname === '/' || pathname === '') pathname = '/index.html';

  const filePath = path.join(ROOT, pathname);

  // Security: prevent directory traversal
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        // SPA fallback: serve index.html for unknown paths
        fs.readFile(path.join(ROOT, 'index.html'), (e2, d2) => {
          if (e2) { res.writeHead(404); res.end('Not found'); return; }
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache',
          });
          res.end(d2);
        });
      } else {
        res.writeHead(500);
        res.end('Server error: ' + err.message);
      }
      return;
    }

    const ext  = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    const isSW = pathname === '/service-worker.js';

    res.writeHead(200, {
      'Content-Type':  mime,
      'Cache-Control': isSW ? 'no-cache' : 'public, max-age=0',
    });
    res.end(data);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('\n  Workout Flow dev server');
  console.log('  ─────────────────────────────────');
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log('  Press Ctrl+C to stop\n');
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use.`);
    console.error(`  Kill the existing process or change PORT in serve.js\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
});