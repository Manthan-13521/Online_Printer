const { execSync } = require('child_process');

function fix() {
  try {
    execSync('pnpm typecheck', { encoding: 'utf8', stdio: 'pipe' });
    console.log("SUCCESS");
  } catch (e) {
    const out = e.stdout + e.stderr;
    const matches = [...out.matchAll(/([a-zA-Z0-9_./-]+)\((\d+),\d+\): error TS/g)];
    const filesToFix = {};
    for (const match of matches) {
      if (!filesToFix[match[1]]) filesToFix[match[1]] = [];
      filesToFix[match[1]].push(parseInt(match[2], 10));
    }
    console.log(filesToFix);
  }
}
fix();
