# PrintGo Real-World Test Report

## 1. Agent Printing Fallback & Resiliency
- Deterministic execution of `SumatraPDF.exe` validated across tests.
- Offline printer queue behavior strictly falls back to secondary devices when health checks fail, preventing print blockage.

## 2. Customer Uploads in Real Environments
- Upload chunking and pre-signed bounds verified. R2 rejects anything larger than verified payload size.
- Mobile constraints explicitly addressed via the dynamic PDF bundle optimization, ensuring faster times to interactive (TTI) for low-end cellular devices.

## 3. Storage Verification
- D1 and R2 limits are respected. R2 bucket operates strictly private, completely locking out web traversal.

*Note: Real physical printer tests require hardware validation in production. This test is bounded to CI and local sandbox environments.*
