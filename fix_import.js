const fs = require('fs');
const file = 'apps/api/worker/src/payments/repository.ts';
let code = fs.readFileSync(file, 'utf8');
code = 'import { UNRESOLVED_PAID_FAILURE_RETENTION_MS } from "@printgo/domain";\n' + code;
fs.writeFileSync(file, code);
