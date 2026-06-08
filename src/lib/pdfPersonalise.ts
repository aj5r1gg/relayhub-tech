import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { DocumentCatalogueItem } from "./documents";
import type { DownloadRecord } from "./downloadTokens";

export async function personalisePdf(input: {
  sourcePdfBytes: ArrayBuffer;
  doc: DocumentCatalogueItem;
  record: DownloadRecord;
}): Promise<Uint8Array> {
  const { sourcePdfBytes, doc, record } = input;

  const pdf = await PDFDocument.load(sourcePdfBytes);

  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdf.embedFont(StandardFonts.HelveticaBold);

  const pages = pdf.getPages();

  const licensedName = `${record.firstName} ${record.lastName}`.trim();

  for (const page of pages) {
    const { width } = page.getSize();

    page.drawText(`${licensedName} • ${record.downloadId}`, {
      x: 36,
      y: 18,
      size: 8,
      font,
      color: rgb(0.35, 0.35, 0.35),
    });

    page.drawText(doc.access === "paid" ? "Redistribution prohibited" : "Free public distribution", {
      x: width - 180,
      y: 18,
      size: 8,
      font,
      color: rgb(0.35, 0.35, 0.35),
    });
  }

  const secondPage = pages[1] ?? pages[0];

  secondPage.drawRectangle({
    x: 36,
    y: 430,
    width: 520,
    height: 250,
    borderColor: rgb(0.75, 0.75, 0.75),
    borderWidth: 1,
    color: rgb(1, 1, 1),
    opacity: 0.92,
  });

  secondPage.drawText("Document Copy Information", {
    x: 56,
    y: 650,
    size: 16,
    font: boldFont,
    color: rgb(0.05, 0.05, 0.05),
  });

  const lines = [
    `Document: ${doc.title} v${doc.version}`,
    `Generated for: ${licensedName}`,
    `Email: ${record.email}`,
    `Download ID: ${record.downloadId}`,
    record.orderNumber ? `Order Number: ${record.orderNumber}` : null,
    `Licence Type: ${doc.licenceType}`,
    `Generated At: ${record.createdAt}`,
    "",
    doc.access === "paid"
      ? "This document is licensed for use by the named licence holder. Redistribution is prohibited."
      : "This document may be shared in its complete and unmodified form. Attribution must be preserved.",
  ].filter(Boolean) as string[];

  let y = 620;

  for (const line of lines) {
    secondPage.drawText(line, {
      x: 56,
      y,
      size: 10,
      font,
      color: rgb(0.08, 0.08, 0.08),
      maxWidth: 480,
    });

    y -= 18;
  }

  pdf.setTitle(`${doc.title} v${doc.version}`);
  pdf.setAuthor("RelayHub");
  pdf.setSubject(`Personalised copy for ${licensedName}`);
  pdf.setKeywords([
    doc.documentId,
    record.downloadId,
    record.email,
    doc.licenceType,
  ]);
  pdf.setProducer("RelayHub Document Delivery System");
  pdf.setCreator("RelayHub");

  return await pdf.save();
}