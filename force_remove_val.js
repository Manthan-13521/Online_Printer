const fs = require('fs');

let code = fs.readFileSync('packages/validation/src/index.test.ts', 'utf8');

// The block looks like:
// const validSettings: ShopSettings = {
//   shopName: "ABC Xerox",
//   contactPhone: "+91 98765 43210",
//   address: "Main Road",
//   customerNotice: "Collect before 8 PM.",
//   onlinePrintingEnabled: true,
//   maxPdfSizeBytes: FILE_SIZE_10_MIB,
//   identificationSheetEnabled: true,
//   identificationSheetPlacement: "FIRST",
// };

code = code.replace(/\n\s*identificationSheetEnabled: true,/, '');
code = code.replace(/\n\s*identificationSheetPlacement: "FIRST",/, '');
code = code.replace(/    \[\{ \.\.\.validSettings, identificationSheetEnabled: "yes" \}, "identificationSheetEnabled"\],\n/g, '');
code = code.replace(/    \[\{ \.\.\.validSettings, identificationSheetPlacement: "MIDDLE" \}, "identificationSheetPlacement"\],\n/g, '');

fs.writeFileSync('packages/validation/src/index.test.ts', code);
