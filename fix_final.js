const fs = require('fs');

let cs = fs.readFileSync('apps/api/worker/src/customer/service.ts', 'utf8');
cs = cs.replace(/, identificationPolicy/g, '');
cs = cs.replace(/import \{.*?isIdentificationRequired.*?\} from "@printgo\/pricing";\n/g, '');
cs = cs.replace(/import \{.*?DEFAULT_IDENTIFICATION_POLICY.*?\} from "@printgo\/domain";\n/g, '');
fs.writeFileSync('apps/api/worker/src/customer/service.ts', cs);

let ps = fs.readFileSync('apps/api/worker/src/payments/service.ts', 'utf8');
ps = ps.replace(/identificationRequired,/g, '');
ps = ps.replace(/\/\/ quote\.identificationRequired \?\? false,/g, '');
fs.writeFileSync('apps/api/worker/src/payments/service.ts', ps);

let pr = fs.readFileSync('apps/api/worker/src/payments/repository.ts', 'utf8');
pr = pr.replace(/identificationRequired: boolean;\n/g, '');
fs.writeFileSync('apps/api/worker/src/payments/repository.ts', pr);

let pt = fs.readFileSync('apps/api/worker/src/phase3.test.ts', 'utf8');
pt = pt.replace(/const configRepo = new D1ConfigurationRepository\(d1\);\n/g, ''); // maybe it's unused?
fs.writeFileSync('apps/api/worker/src/phase3.test.ts', pt);
