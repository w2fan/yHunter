const fs = require("fs");
const { PDFParse } = require("pdf-parse");

async function main() {
  const pdfPath = process.argv[2];
  if (!pdfPath) {
    throw new Error("Missing PDF path");
  }

  const parser = new PDFParse({ data: fs.readFileSync(pdfPath) });

  try {
    const text = (await parser.getText()).text;
    process.stdout.write(text);
  } finally {
    await parser.destroy();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
