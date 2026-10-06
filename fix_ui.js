const fs = require('fs');

function replaceFile(path, replacer) {
  if (fs.existsSync(path)) {
    const orig = fs.readFileSync(path, 'utf8');
    const modified = replacer(orig);
    if (orig !== modified) fs.writeFileSync(path, modified);
  }
}

// customer
replaceFile('apps/web/customer/src/PublicTrackingPage.test.tsx', code => {
  return code.replace(/  identificationRequired: false,\n/g, '');
});

// admin
replaceFile('apps/web/admin/src/App.test.tsx', code => {
  return code.replace(/  identificationSheetEnabled: true,\n/g, '');
});

replaceFile('apps/web/admin/src/DashboardPage.tsx', code => {
  // <dt>ID Check</dt> <dd>{settings?.identificationSheetEnabled ? "ON" : "OFF"}</dd>
  // delete the whole dt and dd
  return code.replace(/<dt>ID Check<\/dt>\s*<dd>\s*\{settings\?.identificationSheetEnabled \? "ON" : "OFF"\}\s*<\/dd>/g, '');
});

replaceFile('apps/web/admin/src/LiveOrdersPage.tsx', code => {
  // It has a conditional render for identificationRequired
  let updated = code.replace(/\{order\.identificationRequired \?\s*\([\s\S]*?<\/span>\s*\)\s*:\s*\(\s*<span[\s\S]*?<\/span>\s*\)\}/g, '');
  updated = updated.replace(/\{order\.identificationRequired[\s\S]*?ID Check Required<\/span>\s*\)\}/g, '');
  return updated;
});

replaceFile('apps/web/admin/src/ManualOrdersPage.tsx', code => {
  return code.replace(/\{order\.identificationRequired \?\s*\([\s\S]*?<\/span>\s*\)\s*:\s*\(\s*<span[\s\S]*?<\/span>\s*\)\}/g, '');
});

replaceFile('apps/web/admin/src/ShopSettingsPage.tsx', code => {
  // delete the whole Identification section
  return code.replace(/<section className="settings-section">[\s\S]*?<h2>Identification Sheet<\/h2>[\s\S]*?<\/section>/g, '');
});
