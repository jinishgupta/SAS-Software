// Minimal dependency-free static file server for the frontend.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const port = process.env.PORT || 5173;

http.createServer((req, res) => {
  const name = req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0];
  const file = path.join(__dirname, path.normalize(name));
  if (!file.startsWith(__dirname) || path.basename(file) === 'server.js' || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('Not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log(`SAS frontend at http://localhost:${port}`));
