import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
const root = resolve("out");
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
  ".ico": "image/x-icon",
};
const base = process.env.NEXT_PUBLIC_BASE_PATH || "";
createServer(async (req, res) => {
  try {
    let pathname = decodeURIComponent(
      new URL(req.url, "http://localhost").pathname,
    );
    if (base) {
      if (!pathname.startsWith(base + "/") && pathname !== base) {
        res.writeHead(404).end();
        return;
      }
      pathname = pathname.slice(base.length) || "/";
    }
    let file = resolve(root, "." + pathname);
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      if ((await stat(file)).isDirectory()) file = resolve(file, "index.html");
    } catch {
      if (!extname(file)) file += ".html";
    }
    const data = await readFile(file);
    res
      .writeHead(200, {
        "Content-Type": mime[extname(file)] || "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "strict-origin-when-cross-origin",
      })
      .end(data);
  } catch {
    res.writeHead(404).end("Not found");
  }
}).listen(Number(process.env.PORT || 3000), "0.0.0.0", () =>
  console.log(`AxFluxo: http://localhost:${process.env.PORT || 3000}${base}/`),
);
