// A static file server that behaves like GitHub Pages.
//
// The only behaviour that matters here is the 404 fallback: GitHub Pages answers an unknown
// path with the contents of `404.html` and a 404 status. A plain `python3 -m http.server`
// does not, so driving the audit scripts through it silently replaced the site's own
// not-found page with Python's error page. Both audit scripts now start this server
// themselves and cannot be pointed at a server that behaves differently.

import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

export const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Start a Pages-like static server for `siteDir`.
 *
 * @param {object} options
 * @param {string} options.siteDir   Absolute path of the built site directory.
 * @param {number} options.port      Port to listen on; `0` asks the OS for a free one.
 * @returns {Promise<{origin: string, port: number, close: () => Promise<void>}>}
 */
export async function serveSite({ siteDir, port = 0 }) {
  const root = normalize(siteDir);
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith("/")) pathname += "index.html";
    const file = join(root, normalize(pathname));

    const send = (target, status) => {
      res.writeHead(status, { "content-type": CONTENT_TYPES[extname(target)] ?? "application/octet-stream" });
      createReadStream(target).pipe(res);
    };

    if (!file.startsWith(root)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    try {
      const info = statSync(file);
      if (!info.isFile()) throw new Error("not a file");
      send(file, 200);
    } catch {
      send(join(root, "404.html"), 404);
    }
  });

  await new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", done);
  });

  const actualPort = server.address().port;
  return {
    origin: `http://127.0.0.1:${actualPort}`,
    port: actualPort,
    // Chromium keeps HTTP keep-alive sockets open, and `server.close()` waits for them, which
    // hangs the script after the last screenshot. Drop the sockets explicitly.
    close: () =>
      new Promise((done) => {
        server.closeAllConnections?.();
        server.close(() => done());
      }),
  };
}
