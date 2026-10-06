const fs = require('fs');

function deleteLinesMatching(file, regexList) {
  if (!fs.existsSync(file)) return;
  let lines = fs.readFileSync(file, 'utf8').split('\n');
  lines = lines.filter(line => !regexList.some(r => r.test(line)));
  fs.writeFileSync(file, lines.join('\n'));
}

deleteLinesMatching('apps/api/worker/src/config/repository.ts', [/identificationSheetEnabled/, /identificationSheetPlacement/]);
deleteLinesMatching('apps/api/worker/src/config/routes.test.ts', [/identificationSheetEnabled/, /identificationSheetPlacement/]);
deleteLinesMatching('apps/api/worker/src/config/service.test.ts', [/identificationSheetEnabled/, /identificationSheetPlacement/]);

let cr = fs.readFileSync('apps/api/worker/src/customer/repository.ts', 'utf8');
cr = cr.replace(/identificationRequired: row\.identification_required === 1,/g, '');
fs.writeFileSync('apps/api/worker/src/customer/repository.ts', cr);

let cs = fs.readFileSync('apps/api/worker/src/customer/service.ts', 'utf8');
cs = cs.replace(/identificationRequired,/g, '');
fs.writeFileSync('apps/api/worker/src/customer/service.ts', cs);

let ps = fs.readFileSync('apps/api/worker/src/payments/service.ts', 'utf8');
ps = ps.replace(/identificationRequired:/g, '//');
fs.writeFileSync('apps/api/worker/src/payments/service.ts', ps);

deleteLinesMatching('apps/api/worker/src/phase3.test.ts', [/identificationRequired/]);

