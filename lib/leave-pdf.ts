import { crc32, inflateSync } from 'node:zlib';
import fontkit from '@pdf-lib/fontkit';
import { decode } from 'jpeg-js';
import {
  concatTransformationMatrix, LineCapStyle, PageSizes, PDFDocument, popGraphicsState, pushGraphicsState, rgb,
} from 'pdf-lib';
import type { PDFFont, PDFPage } from 'pdf-lib';
import { leaveFontBase64 } from './leave-font.ts';
import type { LeaveRecord, Stroke } from './leave-types.ts';

const ink = rgb(0.12, 0.15, 0.20);
const muted = rgb(0.33, 0.37, 0.42);
const rule = rgb(0.72, 0.74, 0.77);
const pen = rgb(0.07, 0.20, 0.44);
const dateFormat = new Intl.DateTimeFormat('ro-RO', { timeZone: 'Europe/Bucharest', dateStyle: 'short' });
const maxScanBytes = 4_000_000;
const maxScanPixels = 20_000_000;
const invalidScan = 'Alege o imagine JPEG sau PNG validă, de cel mult 4 MB și 20 megapixeli.';

function displayDate(value: string) {
  const [year, month, day] = value.split('-');
  return [day, month, year].join('.');
}

function textLines(text: string, font: PDFFont, size: number, width: number) {
  const lines: string[] = [];
  let line = '';
  for (const word of text.trim().split(/\s+/u)) {
    const joined = line ? line + ' ' + word : word;
    if (font.widthOfTextAtSize(joined, size) <= width) {
      line = joined;
      continue;
    }
    if (line) lines.push(line);
    line = '';
    for (const char of word) {
      if (line && font.widthOfTextAtSize(line + char, size) > width) {
        lines.push(line);
        line = '';
      }
      line += char;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawEmployeeSignature(page: PDFPage, strokes: Stroke[], x: number, y: number) {
  // The client reports normalized canvas coordinates with the origin at its top left.
  for (const stroke of strokes) {
    for (let i = 1; i < stroke.length; i++) {
      const from = stroke[i - 1];
      const to = stroke[i];
      page.drawLine({
        start: { x: x + from.x * 184, y: y + (1 - from.y) * 66 },
        end: { x: x + to.x * 184, y: y + (1 - to.y) * 66 },
        color: pen,
        thickness: 1.35,
        lineCap: LineCapStyle.Round,
      });
    }
  }
}

export async function generateLeavePdf(record: LeaveRecord, signature: Stroke[] | null): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setTitle('Cerere de concediu de odihnă');
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(Buffer.from(leaveFontBase64, 'base64'), { subset: true });
  const page = doc.addPage(PageSizes.A4);
  const { width, height } = page.getSize();
  const margin = 70;
  const bodyWidth = width - 2 * margin;

  const heading = 'DOMNULE DIRECTOR';
  page.drawText(heading, {
    x: (width - font.widthOfTextAtSize(heading, 17)) / 2,
    y: height - 142,
    font,
    size: 17,
    color: ink,
  });

  const { legalName, employer } = record.snapshot;
  const days = record.days === 1 ? '1 zi' : String(record.days) + (record.days >= 20 ? ' de zile' : ' zile');
  const paragraph = (
    'Subsemnatul ' + legalName + ', angajat al ' + employer + ', solicit efectuarea unui număr de ' +
    days + ' de concediu de odihnă, în perioada ' + displayDate(record.startDate) + ' - ' +
    displayDate(record.endDate) + '.'
  ).normalize('NFC');
  const lines = textLines(paragraph, font, 13, bodyWidth);
  const bodyY = height - 212;
  page.drawText(lines.join('\n'), { x: margin, y: bodyY, font, size: 13, lineHeight: 21, color: ink });

  const signatureY = bodyY - 21 * (lines.length - 1) - 128;
  const managerX = width - margin - 190;
  page.drawText('Semnătura salariatului', { x: margin, y: signatureY - 18, font, size: 11, color: muted });
  page.drawText('De acord', { x: managerX, y: signatureY + 78, font, size: 11, color: ink });
  page.drawText('Semnătura managerului', { x: managerX, y: signatureY - 18, font, size: 11, color: muted });
  for (const x of [margin, managerX]) {
    page.drawLine({ start: { x, y: signatureY }, end: { x: x + 190, y: signatureY }, thickness: 0.65, color: rule });
  }
  if (signature) drawEmployeeSignature(page, signature, margin + 3, signatureY + 4);

  const timestamp = new Date(record.signedAt ?? record.createdAt);
  page.drawLine({ start: { x: margin, y: 92 }, end: { x: width - margin, y: 92 }, thickness: 0.65, color: rule });
  page.drawText('Cererea nr. ' + record.id, { x: margin, y: 73, font, size: 9, color: muted });
  const dateText = 'Data ' + dateFormat.format(timestamp);
  page.drawText(dateText, { x: width - margin - font.widthOfTextAtSize(dateText, 9), y: 73, font, size: 9, color: muted });

  return doc.save();
}

const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
const pngDepths: Record<number, number[]> = {
  0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16],
};
const pngChannels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const adam7 = [
  [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
  [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2],
];

function checkPixelBounds(width: number, height: number) {
  if (!width || !height || width > 8192 || height > 8192 || width * height > maxScanPixels) {
    throw new Error(invalidScan);
  }
}

function validatedPng(bytes: Uint8Array) {
  const raw = Buffer.from(bytes);
  if (raw.length < 45 || !pngSignature.every((byte, i) => raw[i] === byte) ||
      raw.readUInt32BE(8) !== 13 || raw.toString('latin1', 12, 16) !== 'IHDR') {
    throw new Error(invalidScan);
  }

  const width = raw.readUInt32BE(16);
  const height = raw.readUInt32BE(20);
  const [depth, color, compression, filter, interlace] = raw.subarray(24, 29);
  checkPixelBounds(width, height);
  if (!pngDepths[color]?.includes(depth) || compression !== 0 || filter !== 0 || interlace > 1) {
    throw new Error(invalidScan);
  }

  // Only image data reaches the PDF library. Bound the inflater against the exact
  // scanline sizes before it handles pixels and discard optional image metadata.
  const chunks = [raw.subarray(0, 8), raw.subarray(8, 33)];
  const data: Buffer[] = [];
  let paletteSize = 0;
  let transparency = false;
  let ended = false;
  if (crc32(raw.subarray(12, 29)) !== raw.readUInt32BE(29)) throw new Error(invalidScan);
  for (let offset = 33; offset + 12 <= raw.length;) {
    const length = raw.readUInt32BE(offset);
    const type = raw.toString('latin1', offset + 4, offset + 8);
    const end = offset + length + 12;
    if (end > raw.length || !/^[A-Za-z]{4}$/.test(type)) throw new Error(invalidScan);
    const payload = raw.subarray(offset + 8, end - 4);
    switch (type) {
      case 'PLTE':
        if (paletteSize || data.length || color === 0 || color === 4 ||
            !length || length % 3 !== 0 || length > (color === 3 ? 2 ** depth : 256) * 3) {
          throw new Error(invalidScan);
        }
        paletteSize = length / 3;
        break;
      case 'tRNS':
        if (transparency || data.length || !(color === 0 && length === 2 || color === 2 && length === 6 ||
            color === 3 && length > 0 && length <= paletteSize)) throw new Error(invalidScan);
        transparency = true;
        break;
      case 'IDAT':
        if (color === 3 && !paletteSize) throw new Error(invalidScan);
        data.push(payload);
        break;
      case 'IEND':
        if (length || end !== raw.length || !data.length) throw new Error(invalidScan);
        ended = true;
        break;
      default:
        if (type === 'acTL' || type === 'fcTL' || type === 'fdAT' || /^[A-Z]/.test(type)) {
          throw new Error(invalidScan);
        }
        offset = end;
        continue;
    }
    if (crc32(raw.subarray(offset + 4, end - 4)) !== raw.readUInt32BE(end - 4)) throw new Error(invalidScan);
    chunks.push(raw.subarray(offset, end));
    offset = end;
  }
  if (!ended) throw new Error(invalidScan);

  const scanlines = (interlace ? adam7 : [[0, 0, 1, 1]]).map(([x, y, dx, dy]) => {
    const columns = Math.max(0, Math.ceil((width - x) / dx));
    const rows = columns ? Math.max(0, Math.ceil((height - y) / dy)) : 0;
    return { rows, stride: Math.ceil(columns * depth * pngChannels[color] / 8) + 1 };
  });
  const size = scanlines.reduce((sum, { rows, stride }) => sum + rows * stride, 0);
  const inflated = inflateSync(Buffer.concat(data), { maxOutputLength: size });
  if (inflated.length !== size) throw new Error(invalidScan);
  let offset = 0;
  for (const { rows, stride } of scanlines) {
    for (let row = 0; row < rows; row++, offset += stride) {
      if (inflated[offset] > 4) throw new Error(invalidScan);
    }
  }
  return Buffer.concat(chunks);
}

// JPEG stores orientation in the TIFF IFD inside the optional Exif segment.
function jpegOrientation(exif: Uint8Array | undefined) {
  if (!exif || exif.length < 9 || exif[0] !== 0) return 1;
  // jpeg-js exposes the second NUL from the Exif signature before the TIFF data.
  const tiff = new DataView(exif.buffer, exif.byteOffset + 1, exif.byteLength - 1);
  const order = tiff.getUint16(0);
  const littleEndian = order === 0x4949;
  if (!littleEndian && order !== 0x4d4d || tiff.getUint16(2, littleEndian) !== 42) return 1;
  const offset = tiff.getUint32(4, littleEndian);
  if (offset < 8 || offset + 2 > tiff.byteLength) return 1;
  const entries = tiff.getUint16(offset, littleEndian);
  if (offset + 2 + 12 * entries > tiff.byteLength) return 1;
  for (let i = 0, entry = offset + 2; i < entries; i++, entry += 12) {
    if (tiff.getUint16(entry, littleEndian) !== 0x0112) continue;
    if (tiff.getUint16(entry + 2, littleEndian) !== 3 || tiff.getUint32(entry + 4, littleEndian) !== 1) return 1;
    const orientation = tiff.getUint16(entry + 8, littleEndian);
    return orientation >= 1 && orientation <= 8 ? orientation : 1;
  }
  return 1;
}

// Matrices use PDF coordinates. The final pair translates by the displayed width or height.
const jpegTransforms = [
  [1, 0, 0, 1, 0, 0], [-1, 0, 0, 1, 1, 0], [-1, 0, 0, -1, 1, 1], [1, 0, 0, -1, 0, 1],
  [0, -1, -1, 0, 1, 1], [0, -1, 1, 0, 0, 1], [0, 1, 1, 0, 0, 0], [0, 1, -1, 0, 1, 0],
];

export async function scanToPdf(bytes: Uint8Array, mime: string): Promise<Uint8Array> {
  if (!bytes.length || bytes.length > maxScanBytes) throw new Error(invalidScan);
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setTitle('Cerere de concediu de odihnă scanată');
  let photo;
  let orientation = 1;
  try {
    if (mime === 'image/jpeg') {
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8 ||
          bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) throw new Error(invalidScan);
      const decoded = decode(bytes, {
        useTArray: true,
        tolerantDecoding: false,
        formatAsRGBA: false,
        maxResolutionInMP: maxScanPixels / 1_000_000,
        maxMemoryUsageInMB: 128,
      });
      const { width, height, exifBuffer } = decoded as typeof decoded & { exifBuffer?: Uint8Array };
      checkPixelBounds(width, height);
      orientation = jpegOrientation(exifBuffer);
      photo = await doc.embedJpg(new Uint8Array(bytes));
      if (photo.width !== width || photo.height !== height) throw new Error(invalidScan);
    } else if (mime === 'image/png') {
      photo = await doc.embedPng(validatedPng(bytes));
    } else {
      throw new Error(invalidScan);
    }
  } catch {
    throw new Error(invalidScan);
  }

  const page = doc.addPage(PageSizes.A4);
  const { width, height } = page.getSize();
  const rotated = orientation >= 5;
  const size = rotated ? photo.scaleToFit(height - 64, width - 64) : photo.scaleToFit(width - 64, height - 64);
  const displayedWidth = rotated ? size.height : size.width;
  const displayedHeight = rotated ? size.width : size.height;
  const [a, b, c, d, tx, ty] = jpegTransforms[orientation - 1];
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(
    a, b, c, d, (width - displayedWidth) / 2 + tx * displayedWidth, (height - displayedHeight) / 2 + ty * displayedHeight,
  ));
  page.drawImage(photo, { ...size, x: 0, y: 0 });
  page.pushOperators(popGraphicsState());
  return doc.save();
}
