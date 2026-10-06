const fs = require('fs');
let ps = fs.readFileSync('apps/api/worker/src/payments/service.ts', 'utf8');
ps = ps.replace(/\.\.\.\(payment\.identificationRequired !== undefined[\s\S]*?\{\}\),/g, '');
fs.writeFileSync('apps/api/worker/src/payments/service.ts', ps);
