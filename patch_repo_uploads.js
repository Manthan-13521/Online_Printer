const fs = require('fs');
const file = 'apps/api/worker/src/payments/repository.ts';
let code = fs.readFileSync(file, 'utf8');

// 1. Add back the import
code = code.replace(/import \{ indexToPickupCode \} from "@printgo\/domain";/, `import { UNRESOLVED_PAID_FAILURE_RETENTION_MS } from "@printgo/domain";`);

// 2. Insert the uploads statement into finalizePaid batch
const uploadsStmt = `
      this.db
        .prepare(
          \`UPDATE uploads SET retention_reason = 'UNRESOLVED_PAID_FAILURE', delete_after_ms = ?,
            updated_at_ms = ? WHERE order_id = ?\`
        )
        .bind(
          input.nowMs + UNRESOLVED_PAID_FAILURE_RETENTION_MS,
          input.nowMs,
          before.orderId
        ),`;
code = code.replace(/WHERE id = \? AND status IN \('CREATED', 'PENDING', 'FAILED', 'CANCELLED'\)\`,\n        \)\n        \.bind\([\s\S]*?\),\n/, "$&" + uploadsStmt + "\n");

fs.writeFileSync(file, code);
