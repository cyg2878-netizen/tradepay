import { jsPDF } from 'jspdf';
import { Invoice, Client, formatPenceToGBP } from './data';

function calculateDaysDiff(startDate: string, endDate: string): number {
  try {
    const d1 = new Date(startDate);
    const d2 = new Date(endDate);
    const diff = Math.round((d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24));
    return Math.max(0, isNaN(diff) ? 0 : diff);
  } catch {
    return 0;
  }
}

/**
 * Generates a clean, professional A4 PDF for an invoice in the browser.
 * Uses UK currency formatting (GBP £) and TradePay branding.
 */
export function buildInvoicePDF(invoice: Invoice, client?: Client): jsPDF {
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
  });

  const pageWidth = 210;
  const pageHeight = 297;
  const margin = 15;
  const contentWidth = pageWidth - margin * 2; // 180mm

  // Color palette
  const navy = [11, 21, 40] as const;        // #0B1528
  const yellow = [250, 204, 21] as const;    // #FACC15
  const slateDark = [30, 41, 59] as const;   // #1E293B
  const slateMed = [100, 116, 139] as const; // #64748B
  const slateLight = [241, 245, 249] as const; // #F1F5F9
  const borderGrey = [226, 232, 240] as const; // #E2E8F0

  // 1. Header background accent bar at top
  doc.setFillColor(...navy);
  doc.rect(0, 0, pageWidth, 5, 'F');

  // TradePay Brand Block
  doc.setFillColor(...yellow);
  doc.roundedRect(margin, 14, 10, 10, 2, 2, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(...navy);
  doc.text('T', margin + 3.2, 21.5);

  // 'TradePay' text
  doc.setFontSize(16);
  doc.setTextColor(...navy);
  doc.text('Trade', margin + 13, 21.5);
  doc.setTextColor(202, 138, 4); // Darker amber-yellow for contrast
  doc.text('Pay', margin + 29, 21.5);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(...slateMed);
  doc.text('UK TRADES INVOICING', margin + 13, 25.5);

  // Header Right: "INVOICE" & Invoice Number
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.setTextColor(...navy);
  doc.text('INVOICE', pageWidth - margin, 21, { align: 'right' });

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(...slateMed);
  doc.text(invoice.invoiceNumber, pageWidth - margin, 26, { align: 'right' });

  // Status Badge
  const statusUpper = (invoice.status || 'DRAFT').toUpperCase();
  const badgeWidth = 26;
  const badgeHeight = 5.5;
  const badgeX = pageWidth - margin - badgeWidth;
  const badgeY = 28.5;

  if (invoice.status === 'paid') {
    doc.setFillColor(209, 250, 229); // emerald-100
    doc.roundedRect(badgeX, badgeY, badgeWidth, badgeHeight, 1.5, 1.5, 'F');
    doc.setTextColor(6, 95, 70); // emerald-800
  } else if (invoice.status === 'partly paid') {
    doc.setFillColor(254, 243, 199); // amber-100
    doc.roundedRect(badgeX, badgeY, badgeWidth, badgeHeight, 1.5, 1.5, 'F');
    doc.setTextColor(146, 64, 14); // amber-800
  } else if (invoice.status === 'sent') {
    doc.setFillColor(219, 234, 254); // blue-100
    doc.roundedRect(badgeX, badgeY, badgeWidth, badgeHeight, 1.5, 1.5, 'F');
    doc.setTextColor(30, 64, 175); // blue-800
  } else {
    doc.setFillColor(...slateLight);
    doc.roundedRect(badgeX, badgeY, badgeWidth, badgeHeight, 1.5, 1.5, 'F');
    doc.setTextColor(...slateMed);
  }
  doc.setFontSize(7.5);
  doc.setFont('helvetica', 'bold');
  doc.text(statusUpper, badgeX + badgeWidth / 2, badgeY + 4, { align: 'center' });

  // Divider line
  doc.setDrawColor(...borderGrey);
  doc.setLineWidth(0.4);
  doc.line(margin, 37, pageWidth - margin, 37);

  // 2. Client & Invoice Info Section
  // Left: Invoice To
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(...slateMed);
  doc.text('INVOICE TO:', margin, 44);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...navy);
  const clientName = client?.name || 'Customer';
  doc.text(clientName, margin, 49);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(...slateDark);
  let clientY = 53.5;
  if (client?.address) {
    const splitAddr = doc.splitTextToSize(client.address, 75);
    doc.text(splitAddr, margin, clientY);
    clientY += splitAddr.length * 4;
  }
  if (client?.phone) {
    doc.text(`Phone: ${client.phone}`, margin, clientY);
    clientY += 4;
  }
  if (client?.email) {
    doc.text(`Email: ${client.email}`, margin, clientY);
    clientY += 4;
  }

  // Right: Dates & Invoice Meta
  const infoX = 130;
  const valueX = pageWidth - margin;

  const drawMetaRow = (label: string, value: string, yPos: number) => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(...slateMed);
    doc.text(label, infoX, yPos);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(...navy);
    doc.text(value, valueX, yPos, { align: 'right' });
  };

  drawMetaRow('INVOICE DATE:', invoice.date || '-', 44);
  drawMetaRow('PAYMENT DUE:', invoice.dueDate || '-', 49);
  const termsText =
    invoice.dueDate && invoice.date
      ? `${calculateDaysDiff(invoice.date, invoice.dueDate)} days`
      : 'Due on receipt';
  drawMetaRow('PAYMENT TERMS:', termsText, 54);
  drawMetaRow('CURRENCY:', 'GBP (£)', 59);

  const metaBottomY = Math.max(clientY, 64);
  const tableStartY = metaBottomY + 5;

  // 3. Line Items Table
  const colXDesc = margin + 3;
  const colXQty = margin + 105;
  const colXUnit = margin + 135;
  const colXTotal = pageWidth - margin - 3;

  const thHeight = 8;
  doc.setFillColor(...navy);
  doc.roundedRect(margin, tableStartY, contentWidth, thHeight, 1, 1, 'F');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(255, 255, 255);
  doc.text('DESCRIPTION', colXDesc, tableStartY + 5.5);
  doc.text('QTY', colXQty, tableStartY + 5.5, { align: 'center' });
  doc.text('UNIT PRICE', colXUnit, tableStartY + 5.5, { align: 'right' });
  doc.text('TOTAL', colXTotal, tableStartY + 5.5, { align: 'right' });

  // Rows
  let curY = tableStartY + thHeight;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);

  const items = invoice.lineItems || [];
  items.forEach((item, index) => {
    const isEven = index % 2 === 0;
    const splitDesc = doc.splitTextToSize(item.description || 'Service/Materials', 95);
    const rowHeight = Math.max(8, splitDesc.length * 4.5 + 3.5);

    if (isEven) {
      doc.setFillColor(250, 250, 252);
      doc.rect(margin, curY, contentWidth, rowHeight, 'F');
    }

    doc.setDrawColor(...borderGrey);
    doc.setLineWidth(0.2);
    doc.line(margin, curY + rowHeight, pageWidth - margin, curY + rowHeight);

    // Description
    doc.setTextColor(...slateDark);
    doc.text(splitDesc, colXDesc, curY + 4.5);

    // Type indicator
    if (item.type && item.type !== 'other') {
      doc.setFontSize(6.5);
      doc.setTextColor(...slateMed);
      doc.text(`[${item.type}]`, colXDesc + 1, curY + splitDesc.length * 4.5 + 2.5);
      doc.setFontSize(8.5);
    }

    // Qty
    doc.setTextColor(...slateDark);
    doc.text(String(item.quantity), colXQty, curY + 4.5, { align: 'center' });

    // Unit Price
    doc.text(formatPenceToGBP(item.unitPrice), colXUnit, curY + 4.5, { align: 'right' });

    // Total Price
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...navy);
    doc.text(formatPenceToGBP(item.totalPrice), colXTotal, curY + 4.5, { align: 'right' });
    doc.setFont('helvetica', 'normal');

    curY += rowHeight;
  });

  if (items.length === 0) {
    curY += 8;
    doc.setTextColor(...slateMed);
    doc.text('No line items recorded', margin + 3, curY);
    curY += 6;
  }

  // 4. Totals Block & Notes
  const totalsStartY = curY + 5;
  const totalsWidth = 75;
  const totalsX = pageWidth - margin - totalsWidth;

  // Notes on Left
  let notesHeight = 0;
  if (invoice.notes && invoice.notes.trim()) {
    const notesWidth = 95;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(...slateMed);
    doc.text('NOTES:', margin, totalsStartY);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...slateDark);
    const splitNotes = doc.splitTextToSize(invoice.notes.trim(), notesWidth - 6);
    notesHeight = splitNotes.length * 4 + 6;

    doc.setFillColor(248, 250, 252);
    doc.setDrawColor(...borderGrey);
    doc.roundedRect(margin, totalsStartY + 2, notesWidth, notesHeight, 1.5, 1.5, 'FD');
    doc.text(splitNotes, margin + 3, totalsStartY + 6.5);
  }

  // Totals Breakdown on Right
  let tRowY = totalsStartY;
  const drawTotalRow = (label: string, val: string, isBold = false) => {
    doc.setFont('helvetica', isBold ? 'bold' : 'normal');
    doc.setFontSize(isBold ? 9 : 8.5);
    doc.setTextColor(
      isBold ? navy[0] : slateMed[0],
      isBold ? navy[1] : slateMed[1],
      isBold ? navy[2] : slateMed[2]
    );
    doc.text(label, totalsX, tRowY);

    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...navy);
    doc.text(val, pageWidth - margin, tRowY, { align: 'right' });
    tRowY += 5.5;
  };

  drawTotalRow('Subtotal:', formatPenceToGBP(invoice.subtotal));
  drawTotalRow(`VAT (${invoice.vatRate}%):`, formatPenceToGBP(invoice.vatAmount));
  drawTotalRow('Total Amount:', formatPenceToGBP(invoice.total), true);

  if (invoice.amountPaid > 0) {
    drawTotalRow('Amount Paid:', formatPenceToGBP(invoice.amountPaid), false);
  }

  tRowY += 1;
  // Balance Due row
  const isBalanceZero = invoice.balanceDue <= 0;
  doc.setFillColor(isBalanceZero ? 236 : 255, isBalanceZero ? 253 : 241, isBalanceZero ? 245 : 242);
  doc.setDrawColor(isBalanceZero ? 167 : 254, isBalanceZero ? 243 : 205, isBalanceZero ? 208 : 211);
  doc.roundedRect(totalsX - 2, tRowY - 3.5, totalsWidth + 2, 8, 1.5, 1.5, 'FD');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.5);
  doc.setTextColor(...navy);
  doc.text('Balance Due:', totalsX, tRowY + 1.5);

  doc.setFontSize(10.5);
  if (isBalanceZero) {
    doc.setTextColor(16, 149, 102); // emerald
  } else {
    doc.setTextColor(225, 29, 72); // rose-600
  }
  doc.text(formatPenceToGBP(invoice.balanceDue), pageWidth - margin, tRowY + 1.5, { align: 'right' });

  // 5. Payments History summary (if any)
  const payments = invoice.payments || [];
  if (payments.length > 0) {
    const payStartY = Math.max(totalsStartY + notesHeight + 8, tRowY + 10);
    if (payStartY < pageHeight - 35) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.setTextColor(...slateMed);
      doc.text('PAYMENTS RECORDED:', margin, payStartY);

      let pY = payStartY + 4;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      payments.slice(0, 3).forEach((p) => {
        doc.setTextColor(...slateDark);
        doc.text(
          `• ${p.date} - ${p.method.toUpperCase()}: ${formatPenceToGBP(p.amount)}${
            p.notes ? ` (${p.notes})` : ''
          }`,
          margin + 2,
          pY
        );
        pY += 4;
      });
    }
  }

  // 6. Footer
  doc.setDrawColor(...borderGrey);
  doc.setLineWidth(0.3);
  doc.line(margin, pageHeight - 16, pageWidth - margin, pageHeight - 16);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(...slateMed);
  doc.text('TradePay — Mobile-first Invoicing for UK Trades', margin, pageHeight - 10);
  doc.text('Thank you for your business!', pageWidth - margin, pageHeight - 10, { align: 'right' });

  return doc;
}

/**
 * Downloads the generated PDF directly in the browser.
 */
export function downloadInvoicePDF(invoice: Invoice, client?: Client): void {
  const doc = buildInvoicePDF(invoice, client);
  const filename = `Invoice-${invoice.invoiceNumber || 'draft'}.pdf`;
  doc.save(filename);
}

/**
 * Generates a Blob for the PDF.
 */
export function getInvoicePDFBlob(invoice: Invoice, client?: Client): Blob {
  const doc = buildInvoicePDF(invoice, client);
  return doc.output('blob');
}

/**
 * Generates a File object suitable for the Web Share API.
 */
export function getInvoicePDFFile(invoice: Invoice, client?: Client): File {
  const blob = getInvoicePDFBlob(invoice, client);
  const filename = `Invoice-${invoice.invoiceNumber || 'draft'}.pdf`;
  return new File([blob], filename, { type: 'application/pdf' });
}
