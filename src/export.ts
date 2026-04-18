import { existsSync } from "fs";
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
} from "docx";
import { marked } from "marked";
import puppeteer from "puppeteer-core";

// ── RTL detection ──
const HEBREW_RE = /[\u0590-\u05FF]/;
function isRTL(s: string): boolean {
  return HEBREW_RE.test(s);
}

// ── Markdown → DOCX ──
// Simple parser: handles # H1, ## H2, ### H3, **bold**, *italic*, - list items, blank-line paragraphs.
function parseInline(line: string): TextRun[] {
  const runs: TextRun[] = [];
  // Pattern: **bold** | *italic* | regular
  const re = /(\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`)/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  const isLineRTL = isRTL(line);
  while ((m = re.exec(line)) !== null) {
    if (m.index > lastIdx) {
      const text = line.slice(lastIdx, m.index);
      if (text) runs.push(new TextRun({ text, rightToLeft: isLineRTL }));
    }
    if (m[2]) runs.push(new TextRun({ text: m[2], bold: true, rightToLeft: isLineRTL }));
    else if (m[3]) runs.push(new TextRun({ text: m[3], italics: true, rightToLeft: isLineRTL }));
    else if (m[4]) runs.push(new TextRun({ text: m[4], font: "Consolas", rightToLeft: isLineRTL }));
    lastIdx = re.lastIndex;
  }
  if (lastIdx < line.length) {
    const text = line.slice(lastIdx);
    if (text) runs.push(new TextRun({ text, rightToLeft: isLineRTL }));
  }
  if (!runs.length) runs.push(new TextRun({ text: line, rightToLeft: isLineRTL }));
  return runs;
}

export async function markdownToDocx(md: string): Promise<Buffer> {
  const docIsRTL = isRTL(md);
  const lines = md.split(/\r?\n/);
  const paragraphs: Paragraph[] = [];

  let inList = false;

  for (const raw of lines) {
    const line = raw.trimEnd();

    // Blank line
    if (!line.trim()) {
      inList = false;
      paragraphs.push(new Paragraph({
        children: [new TextRun({ text: "" })],
        bidirectional: docIsRTL,
      }));
      continue;
    }

    // Headings
    const h = line.match(/^(#{1,3})\s+(.+)$/);
    if (h) {
      const level = h[1].length === 1 ? HeadingLevel.HEADING_1
                  : h[1].length === 2 ? HeadingLevel.HEADING_2
                  : HeadingLevel.HEADING_3;
      paragraphs.push(new Paragraph({
        heading: level,
        children: parseInline(h[2]),
        bidirectional: isRTL(h[2]),
        alignment: isRTL(h[2]) ? AlignmentType.RIGHT : AlignmentType.LEFT,
      }));
      continue;
    }

    // Horizontal rule
    if (/^---+$/.test(line)) {
      paragraphs.push(new Paragraph({
        children: [new TextRun({ text: "─".repeat(40) })],
        alignment: AlignmentType.CENTER,
      }));
      continue;
    }

    // List items: - or *
    const li = line.match(/^[-*]\s+(.+)$/);
    if (li) {
      inList = true;
      paragraphs.push(new Paragraph({
        children: parseInline("• " + li[1]),
        bidirectional: isRTL(li[1]),
        alignment: isRTL(li[1]) ? AlignmentType.RIGHT : AlignmentType.LEFT,
        indent: { start: 360 },
      }));
      continue;
    }

    // Numbered list
    const nli = line.match(/^\d+\.\s+(.+)$/);
    if (nli) {
      inList = true;
      paragraphs.push(new Paragraph({
        children: parseInline(line),
        bidirectional: isRTL(nli[1]),
        alignment: isRTL(nli[1]) ? AlignmentType.RIGHT : AlignmentType.LEFT,
        indent: { start: 360 },
      }));
      continue;
    }

    // Regular paragraph
    paragraphs.push(new Paragraph({
      children: parseInline(line),
      bidirectional: isRTL(line),
      alignment: isRTL(line) ? AlignmentType.RIGHT : AlignmentType.LEFT,
    }));
  }

  const doc = new Document({
    creator: "IL Job Scanner",
    title: "Generated",
    styles: {
      default: {
        document: {
          run: { font: "Calibri", size: 22 },
        },
      },
    },
    sections: [{
      properties: {},
      children: paragraphs,
    }],
  });

  const buf = await Packer.toBuffer(doc);
  return Buffer.from(buf);
}

// ── Markdown → PDF (via puppeteer-core + system browser) ──

function findBrowser(): string | null {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    // Windows
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    // macOS
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    // Linux
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ].filter(Boolean) as string[];

  return candidates.find((p) => existsSync(p)) || null;
}

function htmlTemplate(bodyHtml: string, isRtl: boolean): string {
  return `<!doctype html>
<html lang="${isRtl ? "he" : "en"}" dir="${isRtl ? "rtl" : "ltr"}">
<head>
<meta charset="utf-8" />
<style>
  @page { margin: 22mm 18mm; }
  body {
    font-family: "Segoe UI", Arial, sans-serif;
    font-size: 11pt;
    line-height: 1.55;
    color: #1c1f23;
    max-width: 100%;
  }
  h1 { font-size: 20pt; margin: 0 0 6pt; border-bottom: 2px solid #1c1f23; padding-bottom: 4pt; }
  h2 { font-size: 14pt; margin: 16pt 0 4pt; color: #2f5b8c; }
  h3 { font-size: 12pt; margin: 12pt 0 4pt; }
  p { margin: 0 0 8pt; }
  ul, ol { margin: 0 0 8pt; padding-${isRtl ? "right" : "left"}: 22pt; }
  li { margin-bottom: 3pt; }
  hr { border: none; border-top: 1px solid #ccc; margin: 12pt 0; }
  code { font-family: Consolas, monospace; background: #f3f4f6; padding: 1pt 4pt; border-radius: 3pt; }
  strong { font-weight: 600; }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

export async function markdownToPdf(md: string): Promise<Buffer> {
  const exe = findBrowser();
  if (!exe) {
    throw new Error("לא נמצא דפדפן Chrome/Edge במחשב. הגדר CHROME_PATH ב-.env לנתיב המלא של chrome.exe");
  }

  const html = await marked.parse(md, { async: true });
  const fullHtml = htmlTemplate(html as string, isRTL(md));

  const browser = await puppeteer.launch({
    executablePath: exe,
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(fullHtml, { waitUntil: "load" });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "22mm", bottom: "22mm", left: "18mm", right: "18mm" },
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}
