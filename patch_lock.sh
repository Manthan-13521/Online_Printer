awk '
/const log = new RotatingLog/ {
  print "  try {"
  print "    await acquireSingleInstanceLock();"
  print "  } catch (err) {"
  print "    console.error(\"[PrintGo Agent] ❌ Another instance of PrintGo Agent is already running.\");"
  print "    console.error(\"Only one agent daemon can run per computer to prevent print duplication.\");"
  print "    process.exit(1);"
  print "  }"
  print ""
}
{ print }
' apps/agent/windows/src/index.ts > tmp_index2.ts && mv tmp_index2.ts apps/agent/windows/src/index.ts
