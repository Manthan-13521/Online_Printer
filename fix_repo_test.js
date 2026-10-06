const fs = require('fs');

// payments/repository.test.ts
let pr = fs.readFileSync('apps/api/worker/src/payments/repository.test.ts', 'utf8');
pr = pr.replace(/discount_amount_paise: 520,\n\s*identification_required: 0,/g, 'discount_amount_paise: 520,');
fs.writeFileSync('apps/api/worker/src/payments/repository.test.ts', pr);

// config/routes.test.ts
let cr = fs.readFileSync('apps/api/worker/src/config/routes.test.ts', 'utf8');
cr = cr.replace(/const input = \{ \.\.\.settings, shopName: "City Prints" \};/g, 'const { identificationSheetEnabled, identificationSheetPlacement, ...restSettings } = settings as any; const input = { ...restSettings, shopName: "City Prints" };');
fs.writeFileSync('apps/api/worker/src/config/routes.test.ts', cr);
