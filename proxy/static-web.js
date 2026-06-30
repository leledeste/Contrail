'use strict';

const fs = require('fs');
const path = require('path');

function createStaticWebHandler(webDir) {
  // The webapp is static and intentionally served by the same process as the
  // proxy. This keeps setup to "run start.bat, open localhost".
  return (req, res) => {
    let rawPath = '/';
    try {
      rawPath = decodeURIComponent((req.url || '/').split('?')[0]);
    } catch (_) {
      res.writeHead(400); res.end('Bad request'); return;
    }

    const safePath = rawPath === '/' ? 'index.html' : rawPath.replace(/^\/+/, '');
    const filePath = path.normalize(path.join(webDir, safePath));
    const relativePath = path.relative(webDir, filePath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      // path.relative is safer than a string prefix check on Windows, where a
      // sibling such as "webapp2" would otherwise share the same text prefix.
      res.writeHead(403); res.end('Forbidden'); return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      const ext = path.extname(filePath).toLowerCase();
      const mime = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.css' ? 'text/css' : ext === '.js' ? 'text/javascript' : 'text/plain';
      res.writeHead(200, { 'Content-Type': mime });
      res.end(data);
    });
  };
}

module.exports = {
  createStaticWebHandler,
};
