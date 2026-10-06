const { execSync } = require('child_process');
const fs = require('fs');

let testFile = fs.readFileSync('apps/api/worker/src/config/routes.test.ts', 'utf8');
testFile = testFile.replace(/expect\(response.status\).toBe\(200\);/, 'if(response.status !== 200) console.log(await response.text()); expect(response.status).toBe(200);');
fs.writeFileSync('apps/api/worker/src/config/routes.test.ts', testFile);

try {
  execSync('pnpm test -- apps/api/worker/src/config/routes.test.ts', { stdio: 'inherit' });
} catch(e) {}
