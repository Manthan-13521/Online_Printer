import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export async function inspectPdf(file: File): Promise<number> {
  const task = getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    stopAtErrors: true,
  });
  try {
    const document = await task.promise;
    return document.numPages;
  } catch (caught) {
    if (caught instanceof Error && caught.name === "PasswordException") {
      throw new Error("PASSWORD_PROTECTED", { cause: caught });
    }
    throw new Error("INVALID_PDF", { cause: caught });
  } finally {
    await task.destroy();
  }
}
