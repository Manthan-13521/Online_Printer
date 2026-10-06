const fs = require('fs');

let pr = fs.readFileSync('apps/api/worker/src/payments/repository.test.ts', 'utf8');
pr = pr.replace(/discount_amount_paise: 520,\n\s*priority_fee_paise: 500,/g, 'discount_amount_paise: 520,\n      identification_required: 0,\n      priority_fee_paise: 500,');
fs.writeFileSync('apps/api/worker/src/payments/repository.test.ts', pr);

