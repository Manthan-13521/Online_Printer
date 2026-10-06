const fs = require('fs');
let code = fs.readFileSync('packages/validation/src/index.ts', 'utf8');

code = code.replace(/  identificationSheetEnabled: boolean;\n/g, '');
code = code.replace(/  identificationSheetPlacement: IdentificationSheetPlacement;\n/g, '');
code = code.replace(/  if \(typeof record\.identificationSheetEnabled !== "boolean"\) \{[\s\S]*?\}\n/g, '');
code = code.replace(/  if \(\!isIdentificationSheetPlacement\(record\.identificationSheetPlacement\)\) \{[\s\S]*?\}\n/g, '');
code = code.replace(/          identificationSheetEnabled:\n\s*record\.identificationSheetEnabled as boolean,\n/g, '');
code = code.replace(/          identificationSheetPlacement:\n\s*record\.identificationSheetPlacement as IdentificationSheetPlacement,\n/g, '');
code = code.replace(/function isIdentificationSheetPlacement[\s\S]*?return false;\n\}/g, '');

fs.writeFileSync('packages/validation/src/index.ts', code);
