// One place that turns an uploaded spreadsheet into rows.
//
// WHY THIS EXISTS AS A ROUTE AT ALL
// Two of DRM's three uploads - the courier's prasadam file and the quick lead
// list - do their column mapping in the browser: the person sees the headings
// that were found, corrects the one that was guessed wrong, and only then is
// anything sent to the server. That is the right shape for those screens, and
// it is why they were reading the file in the browser.
//
// But a browser can read a CSV in twenty lines and cannot read an .xlsx at all
// without a library that costs more to download than the rest of the page. So
// the file comes here, gets read by exactly the same parser the donor-sheet
// import uses, and goes back as rows of text. The mapping UI on those screens
// is untouched; it simply gets its rows from here instead of from FileReader.
//
// The alternative - an xlsx library in the client bundle - would have meant two
// parsers with two sets of quirks, which is how "it imported fine on the other
// page" starts.
//
// NOTHING IS STORED. This reads a file and hands it back. The donor-sheet
// importer parks its rows in lead_import_rows because a sheet of 8,500 donors
// is a decision the office makes over days; a courier's delivery list is read,
// checked and applied in one sitting.

import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { parseWorkbook, cellText } from '../utils/spreadsheet';

const router = Router();
router.use(authenticate);

// Roughly a 25 MB file once base64 is unwound, which is the limit express.json
// is configured for in index.ts. A courier manifest is tens of kilobytes; this
// is here so a wrong file (a video, a database dump) fails with a sentence
// rather than an out-of-memory.
const MAX_ROWS = 20_000;

/**
 * POST /api/files/parse - read a .xlsx/.xlsm/.csv into rows of text.
 *
 * Returns every sheet, because a workbook can have tabs and the caller is the
 * one that knows whether that matters. A CSV comes back as a single sheet named
 * after the file, so a caller that only ever expects one can take sheets[0] and
 * never branch on the format.
 *
 * Values come back as strings, deliberately. These screens show the cell to a
 * person and then send it somewhere that parses it anyway (a phone number, a
 * date); handing over Excel's own value objects would only push the "[object
 * Object]" problem into the browser.
 */
router.post('/parse', async (req, res) => {
  const filename = String(req.body?.filename ?? 'upload.csv').slice(0, 255);
  const base64 = String(req.body?.base64 ?? '');
  if (!base64) return res.status(400).json({ error: 'No file received' });

  let buffer: Buffer;
  try {
    buffer = Buffer.from(base64, 'base64');
  } catch {
    return res.status(400).json({ error: 'Could not read this file.' });
  }

  try {
    const parsed = await parseWorkbook(buffer, filename);
    if (!parsed.length) return res.status(400).json({ error: 'The file is empty.' });

    const sheets = parsed.map((s) => ({
      name: s.name,
      headers: s.headers,
      // Trimmed to MAX_ROWS rather than refused: a person who uploaded the
      // wrong file finds out from the preview, and one who has a genuinely
      // enormous sheet is told the number that was read.
      rows: s.rows.slice(0, MAX_ROWS).map((r) => s.headers.map((_, i) => cellText(r[i]).trim())),
      rowNumbers: s.rowNumbers.slice(0, MAX_ROWS),
      rows_total: s.rows.length,
      truncated: s.rows.length > MAX_ROWS,
    }));

    res.json({ filename, sheets });
  } catch {
    // The parser only throws on a file that is not the format its extension
    // claims - a renamed PDF, a corrupt download.
    res.status(400).json({ error: 'Could not read this file. Use Excel or CSV.' });
  }
});

export default router;
