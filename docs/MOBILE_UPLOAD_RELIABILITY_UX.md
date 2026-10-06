# Mobile Upload Reliability & UX Audit Report

## 1. Investigation of False "Check Connection"

During our trace of the upload chain (`file picker -> XHR PUT -> Finalization`), we found that `uploadDirectly` utilized `XMLHttpRequest` without specific timeout or abort handlers that differentiated from a standard `error` event.
On mobile browsers (especially Safari/iPhone or Chrome/Android), when the screen locks, a tab is backgrounded, or network conditions briefly fluctuate (like switching from WiFi to Cellular), the OS may aggressively pause or terminate active TCP connections.
When this happens, the `XMLHttpRequest` fires a generic `error` event. Previously, this generic `error` and `Failed to fetch` (which happens if `customerApi` calls fail due to the same reasons) were blanket-caught and mapped to the generic `customerErrorMessage`: `"Connection lost during upload. Check your connection and try again."`
This confused users who had a working internet connection because their connection dropped temporarily or was paused by the OS, but the UI insisted their connection was completely broken.

## 2. Fixes Implemented for Error Handling & Retries

- **Granular Error Messages**: We updated `customerErrorMessage` to provide specific instructions rather than a generic connection error. For instance, `UPLOAD_NETWORK_ERROR` now advises: `"The upload was interrupted. Keep the app open and don't switch tabs while uploading. Check connection and try again."`
- **Safe Idempotent Retries**: We separated the upload state into per-file properties (`uploadStatus`, `uploadProgress`, `uploadError`). If a file fails, its state becomes `"FAILED"`. Clicking "Try upload again" safely ignores already-uploaded files and re-attempts the failed ones. It will automatically authorize a new upload URL if the draft was already created, making it completely idempotent and safe.

## 3. Remove (X) Button State Race Fix

Previously, removing a file during the active upload phase (`busy=true`) was completely blocked by a `disabled` condition. Worse, if it _was_ removed, the `prepareReview` loop relied on a stale `[...files]` snapshot from when the function started. If a user deleted a file, the `prepareReview` loop would later do `setFiles([...working])` and resurrect the removed file, causing severe state corruption.
**Fixes**:

- The `busy` disabled check was removed from the X button, allowing removal at any time (unless a payment is actively processing).
- The `prepareReview` loop now utilizes a strictly synchronized `filesRef` to verify that the file still exists in the order _before_ transitioning to the next step.
- `AbortController` was integrated into `uploadDirectly`. Clicking the X button now actively fires `controller.abort()`, instantly terminating the `XMLHttpRequest` and freeing up network resources.

## 4. Upload State Machine & Smooth UX

We implemented a robust per-file state machine within the `LocalOrderFile` interface:

- `SELECTED` -> `VALIDATING` -> `UPLOADING` -> `FINALIZING` -> `UPLOADED` (or `FAILED` / `CANCELLED`).
- The UI now renders a native `<progress>` bar and text indicating real-time bytes transferred directly on the file card, giving immediate feedback without waiting for the entire batch to process.
- The X button has been increased to a minimum of `44x44px` CSS touch target for improved mobile accessibility.

## 5. Mobile / Network Test Matrix

The following conditions are handled by the new architecture:

- **Offline / Tab Switched**: The file gracefully fails, marks as `"FAILED"`, and prompts the user to keep the tab open on retry.
- **Large PDFs / Slow Network**: Handled via smooth, independent progress bars per file.
- **Signed URL Expiry**: Explicitly caught via `UPLOAD_HTTP_403` and handled gracefully by prompting a retry (which fetches a fresh URL).
- **Multiple Files**: Files upload independently. A failure on File 2 no longer corrupts File 1's progress.

**Status**: Tests pass locally. Manual validation on actual mobile hardware is recommended before a production deployment, but the state-race and XHR abort mechanisms are fully covered in regression tests.
