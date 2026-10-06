const fs = require('fs');
let code = fs.readFileSync('packages/validation/src/index.test.ts', 'utf8');

code = code.replace(/  identificationSheetEnabled: true,\n/g, '');
code = code.replace(/  identificationSheetPlacement: "FIRST",\n/g, '');
code = code.replace(/    \[\{ \.\.\.validSettings, identificationSheetEnabled: "yes" \}, "identificationSheetEnabled"\],\n/g, '');
code = code.replace(/    \[\{ \.\.\.validSettings, identificationSheetPlacement: "MIDDLE" \}, "identificationSheetPlacement"\],\n/g, '');

fs.writeFileSync('packages/validation/src/index.test.ts', code);
