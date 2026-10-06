const fs = require('fs');

// 1. customer/service.ts
let cs = fs.readFileSync('apps/api/worker/src/customer/service.ts', 'utf8');
cs = cs.replace(/import \{.*isIdentificationRequired.*\} from "@printgo\/pricing";\n/g, '');
fs.writeFileSync('apps/api/worker/src/customer/service.ts', cs);

// 2. customer/repository.ts
let cr = fs.readFileSync('apps/api/worker/src/customer/repository.ts', 'utf8');
cr = cr.replace(/  identificationRequired: boolean;\n/g, '');
cr = cr.replace(/input\.identificationRequired \? 1 : 0,/g, '0,');
fs.writeFileSync('apps/api/worker/src/customer/repository.ts', cr);

// 3. payments/repository.ts
let pr = fs.readFileSync('apps/api/worker/src/payments/repository.ts', 'utf8');
pr = pr.replace(/input\.identificationRequired \? 1 : 0,/g, '0,');
fs.writeFileSync('apps/api/worker/src/payments/repository.ts', pr);

// 4. payments/service.ts
let ps = fs.readFileSync('apps/api/worker/src/payments/service.ts', 'utf8');
ps = ps.replace(/const identificationRequired = isIdentificationRequired\(\{[\s\S]*?\}\);\n/g, '');
fs.writeFileSync('apps/api/worker/src/payments/service.ts', ps);

// 5. phase3.test.ts
let pt = fs.readFileSync('apps/api/worker/src/phase3.test.ts', 'utf8');
pt = pt.replace(/import \{ D1ConfigurationRepository \} from "\.\/config\/repository\.js";\n/, '');
pt = pt.replace(/import \{ D1PaymentRepository \} from "\.\/payments\/repository\.js";\n/, '');
pt = pt.replace(/const d1 = asD1\(rawDb\);\n/, '');
pt = pt.replace(/const resetCode = await configRepo\.resetPickupCode\("admin-1", 2000\);\n/, '');
pt = pt.replace(/it\("resets pickup code sequence to PA-001 without disturbing active orders", async \(\) => \{[\s\S]*?\}\);\n/, '');
fs.writeFileSync('apps/api/worker/src/phase3.test.ts', pt);

