const fs = require('fs');
let code = fs.readFileSync('apps/web/admin/src/ShopSettingsPage.tsx', 'utf8');
code = code.replace(/onChange=\{\(event\) =>\n\s*patch\(\{\}\)\n\s*\}/g, 'onChange={() => patch({})}');
code = code.replace(/checked=\{"LAST" === "FIRST"\}/g, 'checked={false}');
fs.writeFileSync('apps/web/admin/src/ShopSettingsPage.tsx', code);
