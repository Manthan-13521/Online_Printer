export async function inspectPdf(file: File): Promise<number> {
  const [pdfjs, workerUrl] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl.default;

  const task = pdfjs.getDocument({
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
