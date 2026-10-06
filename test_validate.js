const { execSync } = require('child_process');
try {
  execSync('pnpm test -- apps/api/worker/src/config/routes.test.ts', { stdio: 'inherit' });
} catch(e) {}
