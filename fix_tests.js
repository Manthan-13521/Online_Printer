const fs = require('fs');

function replaceFile(path, replacer) {
  if (fs.existsSync(path)) {
    const orig = fs.readFileSync(path, 'utf8');
    const modified = replacer(orig);
    if (orig !== modified) fs.writeFileSync(path, modified);
  }
}

// 1. phase3.test.ts
replaceFile('apps/api/worker/src/phase3.test.ts', code => {
  let res = code.replace(/identification_required,\s*/g, '');
  res = res.replace(/1,\s*\/\/\s*identification_required\n/g, '');
  res = res.replace(/1, \/\/ identification_required/g, '');
  res = res.replace(/0, \/\/ identification_required/g, '');
  return res;
});

// 2. config/routes.test.ts
replaceFile('apps/api/worker/src/config/routes.test.ts', code => {
  return code.replace(/identificationSheetEnabled: true,\n\s*identificationSheetPlacement: "FIRST",\n/g, '');
});

// 3. payments/repository.test.ts
replaceFile('apps/api/worker/src/payments/repository.test.ts', code => {
  let res = code.replace(/"identification_required": 1,/g, '');
  res = res.replace(/identification_required: 1,/g, '');
  res = res.replace(/identification_required: 0,/g, 'identification_required: 0,'); // actually I can just change the expected object to not test it or expect 0
  return res;
});

// 4. payments/service.test.ts
replaceFile('apps/api/worker/src/payments/service.test.ts', code => {
  return code.replace(/identificationRequired: true,\n/g, '');
});

