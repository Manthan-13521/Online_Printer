import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { createRuntime } from "./stress-runtime.mjs";
const runtime = await createRuntime(`.tmp/stress/browser-${Date.now()}`);
runtime.env.CUSTOMER_ALLOWED_ORIGIN = "http://127.0.0.1:4183";
runtime.env.ADMIN_ALLOWED_ORIGIN = "http://127.0.0.1:4184";
const servers = [];
for (const [port, app] of [
  [4183, "customer"],
  [4184, "admin"],
  [4185, "customer"],
]) {
  const root = resolve(`apps/web/${app}/dist`);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (url.pathname === "/__audit_metrics" && req.method === "POST") {
        const chunks = [];
        let total = 0;
        for await (const c of req) {
          total += c.length;
          if (total > 20000) {
            res.writeHead(413).end();
            return;
          }
          chunks.push(c);
        }
        const data = JSON.parse(Buffer.concat(chunks).toString());
        await writeFile(
          `artifacts/browser-${port}.json`,
          JSON.stringify(data, null, 2) + "\n",
        );
        res.writeHead(204).end();
        return;
      }
      if (port === 4185) await new Promise((r) => setTimeout(r, 150));
      if (url.pathname.startsWith("/api/")) {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 131072) {
            res.writeHead(413).end();
            return;
          }
          chunks.push(chunk);
        }
        const method = req.method;
        const body = Buffer.concat(chunks);
        const response = await runtime.api.routeRequest(
          new Request(url, {
            method,
            headers: { ...req.headers, Origin: `http://127.0.0.1:${port}` },
            ...(["GET", "HEAD"].includes(method) ? {} : { body }),
          }),
          runtime.env,
        );
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
        return;
      }
      const path = resolve(root, "." + decodeURIComponent(url.pathname));
      if (path !== root && !path.startsWith(root + sep)) {
        res.writeHead(403).end();
        return;
      }
      const file = path === root ? resolve(root, "index.html") : path;
      let data;
      try {
        data = await readFile(file);
      } catch {
        data = await readFile(resolve(root, "index.html"));
      }
      res.setHeader(
        "Content-Type",
        {
          ".js": "text/javascript",
          ".mjs": "text/javascript",
          ".css": "text/css",
          ".json": "application/json",
          ".svg": "image/svg+xml",
          ".png": "image/png",
          ".webmanifest": "application/manifest+json",
        }[extname(file)] ?? "text/html",
      );
      if (file.endsWith("index.html"))
        data = Buffer.from(
          data
            .toString()
            .replace(
              "</head>",
              `<script>let auditLcp=0,auditCls=0,auditLong=[];for(const type of ['largest-contentful-paint','layout-shift','longtask']){try{new PerformanceObserver(list=>{for(const e of list.getEntries()){if(type==='largest-contentful-paint')auditLcp=e.startTime;if(type==='layout-shift'&&!e.hadRecentInput)auditCls+=e.value;if(type==='longtask')auditLong.push(e.duration);}}).observe({type,buffered:true});}catch{}}addEventListener('load',()=>setTimeout(()=>{fetch('/__audit_metrics',{method:'POST',body:JSON.stringify({label:'local browser observation, not Lighthouse',viewport:{width:innerWidth,height:innerHeight},paint:performance.getEntriesByType('paint').map(e=>({name:e.name,ms:e.startTime})),lcpMs:auditLcp,cls:auditCls,longTaskBlockingMs:auditLong.reduce((a,b)=>a+Math.max(0,b-50),0),resources:performance.getEntriesByType('resource').map(e=>({path:new URL(e.name).pathname,bytes:e.transferSize,duration:e.duration})),navigation:performance.getEntriesByType('navigation').map(e=>({domContentLoaded:e.domContentLoadedEventEnd,load:e.loadEventEnd}))})});},2000));</script></head>`,
            ),
        );
      if (port === 4185) {
        for (let i = 0; i < data.length; i += 8000) {
          res.write(data.subarray(i, i + 8000));
          await new Promise((r) => setTimeout(r, 50));
        }
        res.end();
      } else res.end(data);
    } catch {
      res.writeHead(500).end("Synthetic test server error");
    }
  });
  server.listen(port, "127.0.0.1");
  servers.push(server);
}
console.log(
  "Synthetic browser fixture server: localhost 4183 customer, 4184 admin, 4185 throttled customer. No production credentials loaded.",
);
process.on("SIGINT", () => {
  for (const s of servers) s.close();
  runtime.close();
  process.exit(0);
});
