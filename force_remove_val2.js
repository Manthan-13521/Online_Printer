const fs = require('fs');

let code = fs.readFileSync('packages/validation/src/index.test.ts', 'utf8');

code = code.replace(/  it\.each\(\["FIRST", "LAST"\] as const\)\([\s\S]*?\}\,\n  \);\n/g, '');
code = code.replace(/    \[\n      \{ \.\.\.validSettings, identificationSheetPlacement: "MIDDLE" \},\n      "identificationSheetPlacement",\n    \],\n/g, '');
code = code.replace(/    \[\{ \.\.\.validSettings, identificationSheetEnabled: "yes" \}, "identificationSheetEnabled"\],\n/g, '');
code = code.replace(/    \[\n      \{ \.\.\.validSettings, identificationSheetEnabled: "yes" \},\n      "identificationSheetEnabled",\n    \],\n/g, '');

fs.writeFileSync('packages/validation/src/index.test.ts', code);
