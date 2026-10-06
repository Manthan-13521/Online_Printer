const fs = require('fs');

function replaceFile(path, replacer) {
  if (fs.existsSync(path)) {
    const orig = fs.readFileSync(path, 'utf8');
    const modified = replacer(orig);
    if (orig !== modified) fs.writeFileSync(path, modified);
  }
}

replaceFile('apps/web/admin/src/DashboardPage.tsx', code => {
  return code.replace(/settings\?\.identificationSheetEnabled/g, 'false');
});
replaceFile('apps/web/admin/src/LiveOrdersPage.tsx', code => {
  return code.replace(/order\.identificationRequired/g, 'false');
});
replaceFile('apps/web/admin/src/ManualOrdersPage.tsx', code => {
  return code.replace(/order\.identificationRequired/g, 'false');
});
replaceFile('apps/web/admin/src/ShopSettingsPage.tsx', code => {
  code = code.replace(/settings\.identificationSheetEnabled/g, 'false');
  code = code.replace(/settings\.identificationSheetPlacement/g, '"LAST"');
  code = code.replace(/patch\(\{ identificationSheetEnabled: event\.target\.checked \}\)/g, 'patch({})');
  code = code.replace(/patch\(\{ identificationSheetPlacement: "FIRST" \}\)/g, 'patch({})');
  code = code.replace(/patch\(\{ identificationSheetPlacement: "LAST" \}\)/g, 'patch({})');
  return code;
});

