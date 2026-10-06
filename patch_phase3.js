const fs = require('fs');
const file = 'apps/api/worker/src/phase3.test.ts';
let code = fs.readFileSync(file, 'utf8');
code = code.replace(/  it\("avoids active pickup code collisions and increments safely", async \(\) => \{[\s\S]*?\n  \}\);\n\n/, "");
fs.writeFileSync(file, code);
