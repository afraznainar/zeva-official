const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const originalCreateServer = http.createServer;
const root = path.join(__dirname, 'dist');
const llmsPath = path.join(root, 'llms.txt');
const card = {
  name: 'Zeva Mandi & Grills',
  version: '1.0.0',
  description: 'Machine-readable discovery for menu, location, hours and reservations.',
  homepage: 'https://www.zevamandiandgrills.in/',
  capabilities: ['site_facts', 'menu', 'location', 'reservations'],
  tools: [
    { name: 'get_site_facts', description: 'Read official restaurant facts and contact details from llms.txt.' },
    { name: 'get_menu', description: 'Read the official menu page.' },
    { name: 'get_location_and_hours', description: 'Read the official location and opening hours.' }
  ]
};

http.createServer = function patchedCreateServer(listener, ...args) {
  return originalCreateServer.call(http, (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const accept = req.headers.accept || '';
    const originalWriteHead = res.writeHead.bind(res);
    res.writeHead = (statusCode, headers, ...writeArgs) => {
      if (statusCode === 200 && headers && typeof headers === 'object' && String(headers['Content-Type'] || '').includes('text/html')) {
        headers.Link = '</llms.txt>; rel="alternate"; type="text/plain"';
      }
      return originalWriteHead(statusCode, headers, ...writeArgs);
    };

    if (req.method === 'GET' && url.pathname === '/.well-known/mcp/server-card.json') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
      return res.end(JSON.stringify(card));
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html') && /text\/markdown/i.test(accept)) {
      let markdown = '# Zeva Mandi & Grills\n\n';
      try { markdown += fs.readFileSync(llmsPath, 'utf8'); } catch { markdown += 'Official restaurant information is available on the website.'; }
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'public, max-age=300', Link: '</llms.txt>; rel="alternate"; type="text/plain"' });
      return res.end(markdown);
    }

    return listener(req, res);
  }, ...args);
};
