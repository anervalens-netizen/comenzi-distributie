export const productPhotoMime = 'image/jpeg';
export const productPhotoPrefix = `data:${productPhotoMime};base64,`;
export const maxProductPhotoBytes = 256 * 1024;
export const maxProductPhotoBase64 = Math.ceil(maxProductPhotoBytes / 3) * 4;
export const maxProductPhotoSide = 800;

export function isProductPhoto(bytes: Uint8Array) {
  const size = bytes.length;
  if (size < 4 || size > maxProductPhotoBytes ||
      bytes[0] !== 0xff || bytes[1] !== 0xd8 ||
      bytes[size - 2] !== 0xff || bytes[size - 1] !== 0xd9) return false;

  // Bound the decoded dimensions using the JPEG frame header before the first scan.
  const word = (offset: number) => bytes[offset] * 256 + bytes[offset + 1];
  let frame = false;
  for (let offset = 2; offset < size - 4;) {
    if (bytes[offset++] !== 0xff) return false;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    const length = word(offset);
    if (offset + 2 > size - 2 || length < 2 || offset + length > size - 2) return false;
    if (marker === 0xda) return frame && length >= 8 && offset + length < size - 2;
    if (marker === 0xc0 || marker === 0xc2) {
      if (frame || length < 11 || bytes[offset + 2] !== 8) return false;
      const height = word(offset + 3), width = word(offset + 5);
      if (!height || !width || Math.max(height, width) > maxProductPhotoSide) return false;
      frame = true;
    }
    offset += length;
  }
  return false;
}
