import { PDFDocument, PDFPage } from "pdf-lib";
import * as pdfJS from "pdfjs-dist";

import pdfJSWorkerURL from "pdfjs-dist/build/pdf.worker?url";
import { sep, storageGet } from "./utils";

interface TaxValues {
  transactions: number;
  basis: number;
  amount: number;
}

pdfJS.GlobalWorkerOptions.workerSrc = pdfJSWorkerURL;

const download = (fileName: string, content: Blob) => {
  const link = document.createElement("a");
  link.setAttribute("download", fileName);
  link.setAttribute("target", "_blank");
  const href = URL.createObjectURL(content);
  link.href = href;
  link.click();
  URL.revokeObjectURL(href);
};

const getMonthIndex = (month: string) =>
  String(Object.keys(MONTHS).indexOf(month) + 1).padStart(2, "0");

const TARGET_EMAIL = "CPIC.TAXDIV@minfin.fed.be";
/** { label: [page, x, y] } */
const COORDINATES: Record<string, [number, number, number]> = {
  month_first: [0, 260, 678],
  month_second: [0, 365, 678],
  no_thresh_12_transactions: [0, 228, 488],
  no_thresh_12_basis: [0, 273, 488],
  no_thresh_12_amount: [0, 405, 488],
  no_thresh_35_transactions: [0, 228, 465],
  no_thresh_35_basis: [0, 273, 465],
  no_thresh_35_amount: [0, 405, 465],
  no_thresh_total: [0, 405, 394],
  total: [1, 314, 460],
  date: [1, 250, 312],
};

const MONTHS: Record<string, string> = {
  january: "janvier",
  february: "février",
  march: "mars",
  april: "avril",
  may: "mai",
  june: "juin",
  july: "juillet",
  august: "août",
  september: "septembre",
  october: "octobre",
  november: "novembre",
  december: "décembre",
};

const R_MONTH = new RegExp(
  `((${Object.keys(MONTHS).join("|")})\\s*(\\d+))`,
  "i"
);
const R_PAGE_NO_THRESH_12 = /0[,.]12%/;
const R_PAGE_NO_THRESH_35 = /0[,.]35%/;

const R_TRANSACTIONS = /total transactions/i;
const R_AMOUNT = /total tax amount/i;
const R_BASIS = /total tax basis/i;

export class ReportProcessor {
  months: string[] = [];
  year: string | null = null;
  t12Values: TaxValues = {
    transactions: 0,
    basis: 0,
    amount: 0,
  };
  t35Values: TaxValues = {
    transactions: 0,
    basis: 0,
    amount: 0,
  };
  total = 0;
  pdfPages: PDFPage[] = [];

  fileName = "";
  reference = "";
  reportFiles: File[] = [];
  templateFile: File;
  
  targetvalues: TaxValues | null = null;

  constructor(templateFile: File, reportFiles: Iterable<File>) {
    this.templateFile = templateFile;
    this.reportFiles = [...reportFiles];
  }

  async process(options?: { preview?: boolean; send?: boolean }) {
    if (!this.templateFile) {
      throw new Error("no template");
    }
    if (!this.reportFiles.length) {
      throw new Error("no tax reports");
    }

    await Promise.all(this.reportFiles.map((file) => this._parseReport(file)));

    this.months.sort(
      (a, b) => Number(getMonthIndex(a)) - Number(getMonthIndex(b))
    );

    const templateBuffer = await this.templateFile.arrayBuffer();
    const pdfDoc = await PDFDocument.load(templateBuffer);
    this.pdfPages = pdfDoc.getPages();

    if (this.months.length < 1 || this.months.length > 2) {
      throw new Error("TOB report must include at least 1 month and at most 2");
    }
    this._writeText(`${this._getMonth(0)} ${this.year}`, "month_first");
    if (this.months[1]) {
      this._writeText(`${this._getMonth(1)} ${this.year}`, "month_second");
    }

    if (this.t12Values.transactions) {
      console.log("Transactions taxed at 0.12%");
      console.table(this.t12Values);
      this._writeText(this.t12Values.transactions, "no_thresh_12_transactions");
      this._writeAmount(this.t12Values.basis, "no_thresh_12_basis");
      this._writeAmount(this.t12Values.amount, "no_thresh_12_amount");
    }
    if (this.t35Values.transactions) {
      console.log("Transactions taxed at 0.35%");
      console.table(this.t35Values);
      this._writeText(this.t35Values.transactions, "no_thresh_35_transactions");
      this._writeAmount(this.t35Values.basis, "no_thresh_35_basis");
      this._writeAmount(this.t35Values.amount, "no_thresh_35_amount");
    }
    if (this.total) {
      this._writeAmount(this.total, "no_thresh_total");
      this._writeAmount(this.total, "total");
    }

    this._writeText(new Date().toJSON().slice(0,10).split("-").reverse().join("/"), "date");
    this.reference = '';
    const nationalNumber = storageGet("national-number");
    if (nationalNumber) {
      this.reference += `TOB - ${nationalNumber}`;
    }
    this.fileName = `${nationalNumber} - TOB - ${this.year}_${getMonthIndex(this.months[0])}`;
    let monthLabel = this._getMonth(0);
    if (this.months[1]) {
      this.fileName += `_${getMonthIndex(this.months[1])}`;
      monthLabel += `/${this._getMonth(1)}`;
      this.reference += ` - ${getMonthIndex(this.months[0])}/${this.year} ${getMonthIndex(this.months[1])}/${this.year}`;
    } else {
      this.reference += ` - ${getMonthIndex(this.months[0])}/${this.year}`;
    }

    this.fileName += ".pdf";

    console.log("\nSuccessfully generated:", this.fileName);
    console.log("\nTotal tax amount:", this.total, "EUR\n");

    if (options?.preview) {
      return;
    }

    const pdfBytes = await pdfDoc.save();
    const pdfBlob = new Blob([pdfBytes]);
    download(this.fileName, pdfBlob);

    if (options?.send) {
      const fullName = storageGet("full-name");
      const subject = `TOB ${monthLabel} ${this.year}`;
      window.open(
        `mailto:${TARGET_EMAIL}?subject=${
          fullName ? `${fullName} / ` : ""
        }${nationalNumber ? `${nationalNumber} / ` : ""}${subject}`,
        "_blank"
      );
    }
  }

  _getMonth(monthIndex: number) {
    return MONTHS[this.months[monthIndex]];
  }

  async _parseReport(file: File) {
    const buffer = await file.arrayBuffer();
    const document = await pdfJS.getDocument(buffer).promise;

    for(const i of [...Array(document.numPages).keys()]) {
      await this._parseReportPage(document, i);
    }
  }

  async _parseReportPage(
    pdfDocument: pdfJS.PDFDocumentProxy,
    pageIndex: number
  ) {
    const page = await pdfDocument.getPage(pageIndex + 1);
    const pageContent = await page.getTextContent();

    if (pageIndex === 0) {
      for (const item of pageContent.items) {
        if (!("str" in item)) {
          continue;
        }
        const monthMatch = item.str.trim().match(R_MONTH);
        if (monthMatch) {
          const year = monthMatch[3];
          if (this.year && this.year !== year) {
            throw new Error("TOB reports must be in the same year");
          }
          this.year = year;
          this.months.push(monthMatch[2].toLowerCase());
          return;
        }
      }
      throw new Error("First page should include the report's month and year");
    }

    let onNextValue: ((value: number) => any) | null = null;
    for (const line of pageContent.items) {
      if (!("str" in line)) {
        continue;
      }

      const lineContent = line.str.trim();
      if (!lineContent) {
        continue;
      }

      if (onNextValue) {
        const lineValue = parseFloat(lineContent.replace(/[^\d,.]/g, ""));
        onNextValue(lineValue);
        onNextValue = null;
        continue;
      }

      if (R_PAGE_NO_THRESH_12.test(lineContent)) {
        this.targetvalues = this.t12Values;
      } else if (R_PAGE_NO_THRESH_35.test(lineContent)) {
        this.targetvalues = this.t35Values;
      } else if (R_TRANSACTIONS.test(lineContent)) {
        onNextValue = (value) => {
          this.targetvalues!.transactions += value;
        };
      } else if (R_BASIS.test(lineContent)) {
        onNextValue = (value) => {
          this.targetvalues!.basis += value;
        };
      } else if (R_AMOUNT.test(lineContent)) {
        onNextValue = (value) => {
          this.targetvalues!.amount += value;
          this.total += value;
        };
      }
    }
  }

  _writeAmount(amount: number, cell: keyof typeof COORDINATES) {
    return this._writeText(`${sep(amount)} EUR`, cell);
  }

  _writeText(text: string | number, cell: keyof typeof COORDINATES) {
    const [pageIndex, x, y] = COORDINATES[cell];
    const page = this.pdfPages.at(pageIndex);
    if (!page) {
      throw new Error(`no page at index ${pageIndex}`);
    }
    page.drawText(String(text), { size: 10, x, y });
  }
}
