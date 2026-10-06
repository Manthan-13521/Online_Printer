const fs = require('fs');
let ps = fs.readFileSync('apps/api/worker/src/customer/service.ts', 'utf8');
ps = ps.replace(/const identificationRequired = isIdentificationRequired\(\{[\s\S]*?\}\);\n/g, '');
ps = ps.replace(/import \{ isIdentificationRequired \} from "@printgo\/pricing";\n/g, '');
fs.writeFileSync('apps/api/worker/src/customer/service.ts', ps);

let pay = fs.readFileSync('apps/api/worker/src/payments/service.ts', 'utf8');
pay = pay.replace(/\/\/ row\.identification_required === 1,/g, '');
fs.writeFileSync('apps/api/worker/src/payments/service.ts', pay);

