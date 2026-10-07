awk '
/async function runCli/ {
  print "function acquireSingleInstanceLock(): Promise<net.Server> {"
  print "  return new Promise((resolve, reject) => {"
  print "    const server = net.createServer();"
  print "    server.once(\"error\", (err: NodeJS.ErrnoException) => {"
  print "      if (err.code === \"EADDRINUSE\") {"
  print "        reject(new Error(\"Another instance of PrintGo Agent is already running.\"));"
  print "      } else {"
  print "        reject(err);"
  print "      }"
  print "    });"
  print "    server.listen(43210, \"127.0.0.1\", () => {"
  print "      resolve(server);"
  print "    });"
  print "  });"
  print "}"
  print ""
}
{ print }
' apps/agent/windows/src/index.ts > tmp_index.ts && mv tmp_index.ts apps/agent/windows/src/index.ts
