const fs = require('fs');

function replaceFile(path, replacer) {
  if (fs.existsSync(path)) {
    const orig = fs.readFileSync(path, 'utf8');
    const modified = replacer(orig);
    if (orig !== modified) fs.writeFileSync(path, modified);
  }
}

// 1. api-contract
replaceFile('packages/api-contract/src/index.ts', code => {
  code = code.replace(/  identificationSheetEnabled: boolean;\n/g, '');
  code = code.replace(/  identificationSheetPlacement: IdentificationSheetPlacement;\n/g, '');
  code = code.replace(/export type IdentificationSheetPlacement = "FIRST" \| "LAST";\n/g, '');
  code = code.replace(/export interface IdentificationPolicy \{[\s\S]*?\}\n/g, '');
  code = code.replace(/  identificationPolicy\?: IdentificationPolicy;\n/g, '');
  code = code.replace(/  identificationRequired\?: boolean;\n/g, '');
  code = code.replace(/  identificationRequired: boolean;\n/g, '');
  code = code.replace(/  identificationSheet: \{\n    customerName: string;\n    customerPhone: string;\n    publicJobCode: string;\n    position: number;\n  \} \| null;\n/g, '');
  return code;
});

// 2. validation
replaceFile('packages/validation/src/index.ts', code => {
  code = code.replace(/  identificationSheetEnabled: z\.boolean\(\),\n/g, '');
  code = code.replace(/  identificationSheetPlacement: z\.enum\(\["FIRST", "LAST"\]\),\n/g, '');
  code = code.replace(/const identificationPolicySchema = z\.object\(\{[\s\S]*?\}\);\n\n/g, '');
  code = code.replace(/  identificationPolicy: identificationPolicySchema\.optional\(\),\n/g, '');
  return code;
});

// 3. domain
replaceFile('packages/domain/src/constants.ts', code => {
  code = code.replace(/export const DEFAULT_IDENTIFICATION_POLICY = \{[\s\S]*?\} as const;\n\n/g, '');
  return code;
});
replaceFile('packages/domain/src/index.ts', code => {
  code = code.replace(/export \* from ".\/constants";\n/, 'export * from "./constants";\n');
  return code;
});

