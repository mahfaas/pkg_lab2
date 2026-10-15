/**
 * parsers.js — ручной побайтовый парсинг заголовков изображений.
 * Никаких сторонних библиотек для чтения метаданных.
 * Все форматы разбираются по официальным спецификациям.
 */

'use strict';

// ─── Вспомогательные функции ──────────────────────────────────────────────────

/** Читает 2 байта little-endian */
function readU16LE(buf, off) {
  return buf[off] | (buf[off + 1] << 8);
}
/** Читает 4 байта little-endian */
function readU32LE(buf, off) {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}
/** Читает 2 байта big-endian */
function readU16BE(buf, off) {
  return (buf[off] << 8) | buf[off + 1];
}
/** Читает 4 байта big-endian */
function readU32BE(buf, off) {
  return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
}
/** Читает знаковое 4-байт big-endian (нужно для PNG chunk length) */
function readI32BE(buf, off) {
  return (buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3];
}

// ─── PNG ──────────────────────────────────────────────────────────────────────
/**
 * Сигнатура PNG: 8 байт → 89 50 4E 47 0D 0A 1A 0A
 * Структура файла: сигнатура + чанки (length[4] + type[4] + data + crc[4])
 * Первый чанк ВСЕГДА IHDR (13 байт данных):
 *   Width[4], Height[4], BitDepth[1], ColorType[1],
 *   CompressionMethod[1], FilterMethod[1], InterlaceMethod[1]
 * DPI хранится в чанке pHYs: pixelsPerUnitX[4], pixelsPerUnitY[4], unitSpecifier[1]
 *   unitSpecifier=1 → метры; DPI = значение * 0.0254
 * Валидность: последний чанк должен быть IEND
 */
function parsePNG(buf, fileSize) {
  const PNG_SIG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== PNG_SIG[i]) return { error: 'Неверная сигнатура PNG' };
  }

  // IHDR начинается с байта 8: 4(len)+4(type)+13(data)+4(crc)
  const ihdrLen = readI32BE(buf, 8);
  if (ihdrLen !== 13) return { error: 'IHDR имеет неверную длину' };
  const ihdrType = String.fromCharCode(buf[12], buf[13], buf[14], buf[15]);
  if (ihdrType !== 'IHDR') return { error: 'Первый чанк не IHDR' };

  const width  = readU32BE(buf, 16);
  const height = readU32BE(buf, 20);
  const bitDepth  = buf[24];
  const colorType = buf[25];
  const compression = buf[26]; // всегда 0 (deflate)
  const interlace  = buf[28];

  // Определяем глубину цвета (bitsPerPixel)
  const colorTypeMap = {
    0: { name: 'Grayscale',       channels: 1 },
    2: { name: 'RGB',             channels: 3 },
    3: { name: 'Indexed (палитра)', channels: 1 },
    4: { name: 'Grayscale+Alpha', channels: 2 },
    6: { name: 'RGBA',            channels: 4 },
  };
  const ctInfo = colorTypeMap[colorType] || { name: `Unknown(${colorType})`, channels: 1 };
  const bitsPerPixel = bitDepth * ctInfo.channels;

  // Ищем чанк pHYs для DPI (до конца буфера)
  let dpiX = null, dpiY = null;
  let offset = 8 + 4 + 4 + 13 + 4; // после IHDR
  while (offset + 12 <= buf.length) {
    const chunkLen  = readI32BE(buf, offset);
    const chunkType = String.fromCharCode(buf[offset+4], buf[offset+5], buf[offset+6], buf[offset+7]);
    if (chunkType === 'pHYs' && chunkLen === 9) {
      const pxPerUnitX = readU32BE(buf, offset + 8);
      const pxPerUnitY = readU32BE(buf, offset + 12);
      const unit = buf[offset + 16]; // 1 = metre
      if (unit === 1) {
        dpiX = Math.round(pxPerUnitX * 0.0254);
        dpiY = Math.round(pxPerUnitY * 0.0254);
      } else {
        dpiX = pxPerUnitX; // unit unknown
        dpiY = pxPerUnitY;
      }
    }
    if (chunkType === 'IEND') break;
    if (chunkLen < 0 || offset + 12 + chunkLen > buf.length) break;
    offset += 4 + 4 + chunkLen + 4;
  }

  // Валидация: ищем IEND в конце
  // IEND chunk: 00 00 00 00 49 45 4E 44 AE 42 60 82
  let hasIEND = false;
  if (buf.length >= 12) {
    const tail = buf.slice(buf.length - 12);
    hasIEND = tail[4] === 0x49 && tail[5] === 0x45 && tail[6] === 0x4E && tail[7] === 0x44;
  }

  return {
    format: 'PNG',
    width, height,
    dpiX: dpiX || 'N/A',
    dpiY: dpiY || 'N/A',
    bitDepth: bitsPerPixel,
    colorType: ctInfo.name,
    compression: `Deflate (метод ${compression})`,
    interlace: interlace === 0 ? 'Нет' : 'Adam7',
    valid: hasIEND,
    damaged: !hasIEND ? 'Отсутствует чанк IEND' : null,
    extra: {
      'Тип цвета': ctInfo.name,
      'Бит на канал': bitDepth,
      'Чересстрочность': interlace === 0 ? 'Нет' : 'Adam7',
    }
  };
}

// ─── JPEG ─────────────────────────────────────────────────────────────────────
/**
 * Сигнатура JPG: FF D8
 * Маркеры SOF0/SOF1/SOF2 содержат геометрию:
 *   FF C0/C1/C2 + length[2] + precision[1] + height[2] + width[2] + components[1]
 * DPI хранится в сегменте APP0 (JFIF):
 *   FF E0 + length + "JFIF\0" + major + minor + units + Xdensity + Ydensity
 *   units: 0=нет, 1=DPI, 2=DPCM
 * Матрица квантования — в сегменте DQT (FF DB)
 * Валидность: файл должен заканчиваться маркером EOI = FF D9
 */
function parseJPEG(buf, fileSize) {
  if (buf[0] !== 0xFF || buf[1] !== 0xD8) return { error: 'Неверная сигнатура JPEG' };

  let width = null, height = null, precision = null, components = null;
  let dpiX = null, dpiY = null, dpiUnits = null;
  let quantTables = [];
  let sofMarker = null;

  const compressionMap = {
    0xC0: 'Baseline DCT',
    0xC1: 'Extended Sequential DCT',
    0xC2: 'Progressive DCT',
    0xC3: 'Lossless',
    0xC5: 'Sequential DCT (hierarchical)',
    0xC6: 'Progressive DCT (hierarchical)',
    0xC7: 'Lossless (hierarchical)',
    0xC9: 'Arithmetic Baseline DCT',
    0xCA: 'Arithmetic Progressive DCT',
  };

  let offset = 2;
  while (offset + 3 < buf.length) {
    if (buf[offset] !== 0xFF) break;
    const marker = buf[offset + 1];
    if (marker === 0xD9) break; // EOI
    if (marker === 0xD8) { offset += 2; continue; }
    // Маркеры без длины
    if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD9)) { offset += 2; continue; }

    const segLen = readU16BE(buf, offset + 2); // включает 2 байта длины
    const dataStart = offset + 4;

    // APP0 — JFIF
    // Структура JFIF APP0: "JFIF\0"[5] + major[1] + minor[1] + units[1] + Xdensity[2] + Ydensity[2]
    // Итого: dataStart+0..4 = 'JFIF\0', +5 = major, +6 = minor, +7 = units, +8..9 = Xdensity, +10..11 = Ydensity
    if (marker === 0xE0 && segLen >= 16) {
      const id = String.fromCharCode(buf[dataStart], buf[dataStart+1], buf[dataStart+2], buf[dataStart+3]);
      if (id === 'JFIF') {
        const units = buf[dataStart + 7];              // 0=нет единиц, 1=DPI, 2=DPCM
        const xDens = readU16BE(buf, dataStart + 8);   // Xdensity (big-endian)
        const yDens = readU16BE(buf, dataStart + 10);  // Ydensity (big-endian)
        dpiUnits = units;
        if (units === 1) {
          dpiX = xDens; dpiY = yDens;                  // уже в DPI
        } else if (units === 2) {
          dpiX = Math.round(xDens * 2.54);             // DPCM → DPI (*2.54)
          dpiY = Math.round(yDens * 2.54);
        }
        // units=0: плотность задаёт только соотношение сторон пикселя, не DPI — оставляем null
      }
    }

    // APP1 — Exif может содержать DPI
    if (marker === 0xE1 && segLen >= 14) {
      const id = String.fromCharCode(buf[dataStart], buf[dataStart+1], buf[dataStart+2], buf[dataStart+3]);
      if (id === 'Exif' && dpiX === null) {
        // Попробуем вытащить XResolution/YResolution из EXIF IFD
        try {
          const exifResult = parseExifDPI(buf, dataStart + 6);
          if (exifResult && exifResult.dpiX) { dpiX = exifResult.dpiX; dpiY = exifResult.dpiY; }
        } catch(e) {}
      }
    }

    // SOF маркеры (C0..C3, C5..C7, C9, CA)
    if ((marker >= 0xC0 && marker <= 0xC3) || (marker >= 0xC5 && marker <= 0xC7) || marker === 0xC9 || marker === 0xCA) {
      if (segLen >= 11) {
        precision  = buf[dataStart];
        height     = readU16BE(buf, dataStart + 1);
        width      = readU16BE(buf, dataStart + 3);
        components = buf[dataStart + 5];
        sofMarker  = marker;
      }
    }

    // DQT — таблица квантования (FF DB)
    if (marker === 0xDB) {
      let dqtOffset = dataStart;
      while (dqtOffset < dataStart + segLen - 2) {
        const qtInfo = buf[dqtOffset];
        const precision16 = (qtInfo >> 4) & 0xF; // 0=8bit, 1=16bit
        const tableId = qtInfo & 0xF;
        const tableLen = 64 * (precision16 + 1);
        if (dqtOffset + 1 + tableLen > buf.length) break;
        const table = [];
        for (let i = 0; i < 64; i++) {
          table.push(precision16 === 0 ? buf[dqtOffset + 1 + i] : readU16BE(buf, dqtOffset + 1 + i * 2));
        }
        quantTables.push({ id: tableId, precision: precision16 === 0 ? 8 : 16, data: table });
        dqtOffset += 1 + tableLen;
      }
    }

    offset += 2 + segLen;
    if (segLen < 2) break;
  }

  // Валидация: последние 2 байта файла должны быть FF D9
  // Мы читаем только начало файла, так что проверим в конце буфера
  let hasEOI = false;
  if (buf.length >= 2) {
    hasEOI = buf[buf.length - 2] === 0xFF && buf[buf.length - 1] === 0xD9;
  }

  if (width === null) return { error: 'SOF-маркер не найден' };

  const colorTypeMap = { 1: 'Grayscale', 3: 'YCbCr (RGB)', 4: 'CMYK' };
  const bitsPerPixel = (precision || 8) * (components || 3);

  return {
    format: 'JPEG',
    width, height,
    dpiX: dpiX !== null ? dpiX : 'N/A',
    dpiY: dpiY !== null ? dpiY : 'N/A',
    bitDepth: bitsPerPixel,
    colorType: colorTypeMap[components] || `${components} канала`,
    compression: compressionMap[sofMarker] || `SOF(${sofMarker ? sofMarker.toString(16) : '?'})`,
    valid: hasEOI,
    damaged: !hasEOI ? 'Отсутствует маркер EOI (FF D9)' : null,
    extra: {
      'Компоненты': components,
      'Точность (бит/компонент)': precision,
      'Таблицы квантования': quantTables.length > 0
        ? quantTables.map(qt => `Q${qt.id}[${qt.precision}bit]: ${qt.data.slice(0,8).join(',')}…`).join('; ')
        : 'Не найдены',
    }
  };
}

/** Минипарсер EXIF для извлечения DPI из APP1 */
function parseExifDPI(buf, exifStart) {
  if (exifStart + 8 > buf.length) return null;
  // Определяем порядок байт
  const byteOrder = String.fromCharCode(buf[exifStart], buf[exifStart + 1]);
  const le = byteOrder === 'II';
  const r16 = le ? readU16LE : readU16BE;
  const r32 = le ? readU32LE : readU32BE;

  const tiffMagic = r16(buf, exifStart + 2);
  if (tiffMagic !== 42) return null;

  const ifdOffset = r32(buf, exifStart + 4);
  const ifdStart = exifStart + ifdOffset;
  if (ifdStart + 2 > buf.length) return null;

  const numEntries = r16(buf, ifdStart);
  let dpiX = null, dpiY = null, resUnit = 2;

  for (let i = 0; i < numEntries; i++) {
    const eOff = ifdStart + 2 + i * 12;
    if (eOff + 12 > buf.length) break;
    const tag  = r16(buf, eOff);
    const type = r16(buf, eOff + 2);
    // 0x011A = XResolution, 0x011B = YResolution, 0x0128 = ResolutionUnit
    if (tag === 0x011A || tag === 0x011B) {
      const valOff = r32(buf, eOff + 8);
      const rOff = exifStart + valOff;
      if (rOff + 8 <= buf.length) {
        const num = r32(buf, rOff);
        const den = r32(buf, rOff + 4);
        const val = den !== 0 ? Math.round(num / den) : 0;
        if (tag === 0x011A) dpiX = val;
        else dpiY = val;
      }
    }
    if (tag === 0x0128) resUnit = r16(buf, eOff + 8);
  }

  if (resUnit === 3 && dpiX !== null) {
    dpiX = Math.round(dpiX * 2.54);
    dpiY = Math.round(dpiY * 2.54);
  }
  return (dpiX !== null) ? { dpiX, dpiY } : null;
}

// ─── BMP ──────────────────────────────────────────────────────────────────────
/**
 * Сигнатура BMP: "BM" (42 4D)
 * BITMAPFILEHEADER (14 байт):
 *   bfType[2]="BM", bfSize[4], bfReserved[4], bfOffBits[4]
 * BITMAPINFOHEADER (40 байт, начинается с байта 14):
 *   biSize[4]=40, biWidth[4], biHeight[4], biPlanes[2], biBitCount[2],
 *   biCompression[4], biSizeImage[4], biXPelsPerMeter[4], biYPelsPerMeter[4],
 *   biClrUsed[4], biClrImportant[4]
 * Разрешение: biXPelsPerMeter / 39.3701 = DPI
 * Сжатие: BI_RGB=0, BI_RLE8=1, BI_RLE4=2, BI_BITFIELDS=3
 */
function parseBMP(buf, fileSize) {
  if (buf[0] !== 0x42 || buf[1] !== 0x4D) return { error: 'Неверная сигнатура BMP' };
  if (buf.length < 54) return { error: 'Слишком маленький заголовок BMP', damaged: 'Усечённый заголовок' };

  const bfSize   = readU32LE(buf, 2);
  const bfOffBits = readU32LE(buf, 10);
  const biSize   = readU32LE(buf, 14);
  const width    = readU32LE(buf, 18);
  // biHeight может быть отрицательным (top-down DIB) — знаковое 32-bit
  const heightRaw = (buf[22] | (buf[23] << 8) | (buf[24] << 16) | (buf[25] << 24));
  const height   = Math.abs(heightRaw);
  const topDown  = heightRaw < 0;
  const bitCount = readU16LE(buf, 28);
  const compressionCode = readU32LE(buf, 30);
  const xPPM    = readU32LE(buf, 38); // pixels per metre X
  const yPPM    = readU32LE(buf, 42);
  const clrUsed = readU32LE(buf, 46);

  const compressionMap = {
    0: 'BI_RGB (нет сжатия)',
    1: 'BI_RLE8 (RLE 8 бит)',
    2: 'BI_RLE4 (RLE 4 бита)',
    3: 'BI_BITFIELDS (битовые маски)',
    4: 'BI_JPEG',
    5: 'BI_PNG',
    6: 'BI_ALPHABITFIELDS',
  };

  const dpiX = Math.round(xPPM * 0.0254);
  const dpiY = Math.round(yPPM * 0.0254);

  // Палитра: если bitCount <= 8, есть цветовая таблица
  const hasPalette = bitCount <= 8;
  const paletteColors = clrUsed > 0 ? clrUsed : (hasPalette ? (1 << bitCount) : 0);

  // Валидация размера файла: bfSize в заголовке — задекларированный полный размер файла.
  // Если реальный размер меньше — файл усечён.
  const valid = fileSize === 0 || fileSize >= bfSize;

  return {
    format: 'BMP',
    width, height,
    dpiX: xPPM ? dpiX : 'N/A',
    dpiY: yPPM ? dpiY : 'N/A',
    bitDepth: bitCount,
    colorType: bitCount <= 8 ? 'Indexed (палитра)' : bitCount === 32 ? 'BGRA' : 'BGR',
    compression: compressionMap[compressionCode] || `Unknown(${compressionCode})`,
    valid,
    damaged: !valid ? `Размер в заголовке (${bfSize}) ≠ реальному (${fileSize})` : null,
    extra: {
      'Порядок строк': topDown ? 'Сверху вниз' : 'Снизу вверх',
      'Заголовок DIB (байт)': biSize,
      'Смещение пикселей': bfOffBits,
      'Цветов в палитре': hasPalette ? paletteColors : 'Нет палитры',
      'Размер файла (заголовок)': bfSize + ' байт',
    }
  };
}

// ─── GIF ──────────────────────────────────────────────────────────────────────
/**
 * Сигнатура GIF: "GIF87a" или "GIF89a"
 * Logical Screen Descriptor (7 байт после сигнатуры, с байта 6):
 *   Width[2], Height[2], Packed[1], BackgroundColorIndex[1], PixelAspectRatio[1]
 * Packed byte: GlobalColorTableFlag[1], ColorResolution[3], SortFlag[1], SizeOfGlobalColorTable[3]
 * Размер глобальной таблицы цветов: 2^(SizeOfGCT+1) цветов
 * DPI в GIF не хранится (нет такого поля)
 * Глубина цвета: ColorResolution + 1 бит
 */
function parseGIF(buf, fileSize) {
  const sig = String.fromCharCode(buf[0], buf[1], buf[2], buf[3], buf[4], buf[5]);
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return { error: 'Неверная сигнатура GIF' };
  if (buf.length < 13) return { error: 'Слишком маленький заголовок GIF', damaged: 'Усечённый заголовок' };

  const width  = readU16LE(buf, 6);
  const height = readU16LE(buf, 8);
  const packed = buf[10];

  const hasGCT       = (packed >> 7) & 1;     // флаг глобальной таблицы цветов
  const colorRes     = ((packed >> 4) & 0x7) + 1; // color resolution (бит)
  const gctSize      = packed & 0x7;            // размер GCT: 2^(gctSize+1) цветов
  const numColors    = hasGCT ? (1 << (gctSize + 1)) : 0;
  const bitsPerPixel = gctSize + 1;

  // Считаем анимированность: ищем маркер расширения (0x21) с кодом 0xFF (Application Extension — NETSCAPE)
  let animated = false;
  let frameCount = 0;
  let offset = 13 + (hasGCT ? numColors * 3 : 0);
  while (offset < buf.length - 1) {
    const blockType = buf[offset];
    if (blockType === 0x3B) break; // Trailer — конец GIF
    if (blockType === 0x2C) {
      // Image Descriptor
      frameCount++;
      if (offset + 10 >= buf.length) break;
      const localPacked = buf[offset + 9];
      const hasLCT = (localPacked >> 7) & 1;
      const lctSize = hasLCT ? (1 << ((localPacked & 0x7) + 1)) * 3 : 0;
      offset += 10 + lctSize + 1; // пропускаем LCT и LZW minimum code size
      // пропускаем суб-блоки
      while (offset < buf.length) {
        const subLen = buf[offset];
        offset++;
        if (subLen === 0) break;
        offset += subLen;
      }
    } else if (blockType === 0x21) {
      // Extension
      offset += 2; // extension introducer + label
      while (offset < buf.length) {
        const subLen = buf[offset];
        offset++;
        if (subLen === 0) break;
        offset += subLen;
      }
    } else {
      break;
    }
  }
  animated = frameCount > 1;

  // Валидация: последний байт должен быть 0x3B (Trailer)
  const hasTrailer = buf[buf.length - 1] === 0x3B;

  return {
    format: 'GIF',
    width, height,
    dpiX: 'N/A',
    dpiY: 'N/A',
    bitDepth: bitsPerPixel,
    colorType: 'Indexed (палитра)',
    compression: 'LZW',
    valid: hasTrailer,
    damaged: !hasTrailer ? 'Отсутствует трейлер GIF (0x3B)' : null,
    extra: {
      'Версия': sig,
      'Глобальная таблица цветов': hasGCT ? `${numColors} цветов` : 'Нет',
      'Color Resolution': `${colorRes} бит`,
      'Анимация': animated ? `Да (${frameCount} кадров)` : 'Нет',
    }
  };
}

// ─── TIFF ─────────────────────────────────────────────────────────────────────
/**
 * Сигнатура TIFF: 49 49 2A 00 (Little-Endian) или 4D 4D 00 2A (Big-Endian)
 * Структура: заголовок 8 байт → IFD (Image File Directory)
 * Заголовок: byteOrder[2] + magic[2](42) + offsetToFirstIFD[4]
 * IFD: numEntries[2] + entries (каждая 12 байт):
 *   tag[2] + type[2] + count[4] + valueOffset[4]
 * Типы данных: 1=BYTE, 2=ASCII, 3=SHORT, 4=LONG, 5=RATIONAL
 * Нужные теги:
 *   256 (0x100) = ImageWidth, 257 (0x101) = ImageLength
 *   258 (0x102) = BitsPerSample,  259 (0x103) = Compression
 *   262 (0x106) = PhotometricInterpretation
 *   277 (0x115) = SamplesPerPixel
 *   282 (0x11A) = XResolution (RATIONAL), 283 (0x11B) = YResolution
 *   296 (0x128) = ResolutionUnit (1=нет,2=inch,3=cm)
 */
function parseTIFF(buf, fileSize) {
  if (buf.length < 8) return { error: 'Слишком маленький файл TIFF' };

  const byteOrder = String.fromCharCode(buf[0], buf[1]);
  let le;
  if (byteOrder === 'II') le = true;
  else if (byteOrder === 'MM') le = false;
  else return { error: 'Неверный порядок байт TIFF' };

  const r16 = le ? readU16LE : readU16BE;
  const r32 = le ? readU32LE : readU32BE;

  const magic = r16(buf, 2);
  if (magic !== 42) return { error: 'Неверная магия TIFF (ожидалось 42)' };

  const ifdOffset = r32(buf, 4);
  if (ifdOffset + 2 > buf.length) return { error: 'IFD за пределами буфера' };

  const numEntries = r16(buf, ifdOffset);
  const tags = {};

  for (let i = 0; i < numEntries; i++) {
    const eOff = ifdOffset + 2 + i * 12;
    if (eOff + 12 > buf.length) break;
    const tag   = r16(buf, eOff);
    const type  = r16(buf, eOff + 2);
    const count = r32(buf, eOff + 4);
    const valOff = eOff + 8;

    let value;
    // Если значение влезает в 4 байта — оно хранится прямо в поле valueOffset
    const typeSize = [0,1,1,2,4,8,1,1,2,4,8,4,8];
    const tSize = typeSize[type] || 1;
    const dataSize = tSize * count;

    if (dataSize <= 4) {
      // Значение прямо в valOff
      if (type === 3) value = r16(buf, valOff); // SHORT
      else if (type === 4) value = r32(buf, valOff); // LONG
      else if (type === 1) value = buf[valOff]; // BYTE
      else value = r32(buf, valOff);
    } else {
      // Указатель на данные
      const ptr = r32(buf, valOff);
      if (type === 5 && ptr + 8 <= buf.length) {
        // RATIONAL = числитель[4] / знаменатель[4]
        const num = r32(buf, ptr);
        const den = r32(buf, ptr + 4);
        value = den !== 0 ? num / den : 0;
      } else if (type === 3 && ptr + count * 2 <= buf.length) {
        // Массив SHORT (нужно для BitsPerSample)
        value = [];
        for (let j = 0; j < count; j++) value.push(r16(buf, ptr + j * 2));
      } else {
        value = null;
      }
    }
    tags[tag] = value;
  }

  const width  = tags[256] || 0;
  const height = tags[257] || 0;
  const bps    = tags[258]; // BitsPerSample (может быть массивом)
  const spp    = tags[277] || 1; // SamplesPerPixel
  const compressionCode = tags[259] || 1;
  const xRes   = tags[282];
  const yRes   = tags[283];
  const resUnit = tags[296] || 2;
  const photometric = tags[262];

  let bitsPerPixel;
  if (Array.isArray(bps)) bitsPerPixel = bps.reduce((a, b) => a + b, 0);
  else bitsPerPixel = (bps || 8) * spp;

  const compressionMap = {
    1: 'Без сжатия',
    2: 'CCITT RLE',
    3: 'CCITT Fax3',
    4: 'CCITT Fax4',
    5: 'LZW',
    6: 'JPEG (старый)',
    7: 'JPEG',
    8: 'Adobe Deflate',
    9: 'JBIG (B&W)',
    32773: 'PackBits (RLE)',
    32946: 'Deflate',
  };

  const photometricMap = {
    0: 'WhiteIsZero', 1: 'BlackIsZero', 2: 'RGB', 3: 'Palette',
    4: 'Transparency mask', 5: 'CMYK', 6: 'YCbCr', 8: 'CIELab',
  };

  let dpiX = 'N/A', dpiY = 'N/A';
  if (xRes !== null && xRes !== undefined) {
    if (resUnit === 2) { dpiX = Math.round(xRes); dpiY = Math.round(yRes || xRes); }
    else if (resUnit === 3) { dpiX = Math.round(xRes * 2.54); dpiY = Math.round((yRes || xRes) * 2.54); }
    else { dpiX = Math.round(xRes); dpiY = Math.round(yRes || xRes); }
  }

  return {
    format: 'TIFF',
    width, height,
    dpiX, dpiY,
    bitDepth: bitsPerPixel,
    colorType: photometricMap[photometric] || `PhotometricInterp(${photometric})`,
    compression: compressionMap[compressionCode] || `Unknown(${compressionCode})`,
    valid: true,
    damaged: null,
    extra: {
      'Порядок байт': le ? 'Little-Endian (II)' : 'Big-Endian (MM)',
      'SamplesPerPixel': spp,
      'BitsPerSample': Array.isArray(bps) ? bps.join(',') : bps,
      'Единицы разрешения': resUnit === 2 ? 'DPI' : resUnit === 3 ? 'DPCM' : 'Нет',
    }
  };
}

// ─── PCX ──────────────────────────────────────────────────────────────────────
/**
 * Сигнатура PCX: первый байт = 0x0A (ZSoft PCX)
 * Заголовок 128 байт:
 *   Identifier[1]=0x0A, Version[1], Encoding[1](1=RLE), BitsPerPixel[1],
 *   XMin[2], YMin[2], XMax[2], YMax[2],
 *   HDpi[2], VDpi[2], Colormap[48], Reserved[1],
 *   NPlanes[1], BytesPerLine[2], PaletteInfo[2], HScreenSize[2], VScreenSize[2]
 * Width  = XMax - XMin + 1
 * Height = YMax - YMin + 1
 * BitsPerPixel_total = BitsPerPixel * NPlanes
 */
function parsePCX(buf, fileSize) {
  if (buf[0] !== 0x0A) return { error: 'Неверная сигнатура PCX (ожидался 0x0A)' };
  if (buf.length < 128) return { error: 'Слишком маленький заголовок PCX', damaged: 'Усечённый заголовок' };

  const version     = buf[1];
  const encoding    = buf[2]; // 1 = RLE
  const bpp         = buf[3]; // бит на плоскость на пиксель
  const xMin        = readU16LE(buf, 4);
  const yMin        = readU16LE(buf, 6);
  const xMax        = readU16LE(buf, 8);
  const yMax        = readU16LE(buf, 10);
  const hDpi        = readU16LE(buf, 12);
  const vDpi        = readU16LE(buf, 14);
  const nPlanes     = buf[65];
  const bytesPerLine = readU16LE(buf, 66);
  const paletteInfo = readU16LE(buf, 68); // 1=color, 2=grayscale

  const width  = xMax - xMin + 1;
  const height = yMax - yMin + 1;
  const totalBpp = bpp * nPlanes;

  const versionMap = {
    0: 'PCX 2.5', 2: 'PCX 2.8 (с палитрой)', 3: 'PCX 2.8 (без палитры)',
    4: 'PCX для Windows', 5: 'PCX 3.0+'
  };

  // Палитра VGA 256 цветов хранится в конце файла (768 байт, предваряется 0x0C)
  let has256Palette = false;
  if (buf.length >= 769 && buf[buf.length - 769] === 0x0C) {
    has256Palette = true;
  }

  return {
    format: 'PCX',
    width, height,
    dpiX: hDpi,
    dpiY: vDpi,
    bitDepth: totalBpp,
    colorType: paletteInfo === 2 ? 'Grayscale' : totalBpp <= 8 ? 'Indexed (палитра)' : 'RGB',
    compression: encoding === 1 ? 'RLE (PackBits)' : 'Без сжатия',
    valid: width > 0 && height > 0,
    damaged: (width <= 0 || height <= 0) ? 'Нулевые/отрицательные размеры' : null,
    extra: {
      'Версия PCX': versionMap[version] || `v${version}`,
      'Плоскостей (NPlanes)': nPlanes,
      'Байт на линию': bytesPerLine,
      '256-цветная палитра VGA': has256Palette ? 'Есть (в конце файла)' : 'Нет',
      'Тип палитры': paletteInfo === 1 ? 'Цветная' : 'Оттенки серого',
    }
  };
}

// ─── Детектор формата по магическим числам ────────────────────────────────────
/**
 * Определяем формат файла по содержимому, а не по расширению.
 * Это позволяет обнаружить подменённые расширения.
 */
function detectFormat(buf) {
  if (!buf || buf.length < 4) return null;
  // PNG
  if (buf[0]===0x89 && buf[1]===0x50 && buf[2]===0x4E && buf[3]===0x47) return 'png';
  // JPEG
  if (buf[0]===0xFF && buf[1]===0xD8) return 'jpeg';
  // BMP
  if (buf[0]===0x42 && buf[1]===0x4D) return 'bmp';
  // GIF
  if (buf[0]===0x47 && buf[1]===0x49 && buf[2]===0x46) return 'gif';
  // TIFF LE
  if (buf[0]===0x49 && buf[1]===0x49 && buf[2]===0x2A && buf[3]===0x00) return 'tiff';
  // TIFF BE
  if (buf[0]===0x4D && buf[1]===0x4D && buf[2]===0x00 && buf[3]===0x2A) return 'tiff';
  // PCX
  if (buf[0]===0x0A && buf[1]<=5) return 'pcx';
  return null;
}

// ─── Главная функция парсинга ─────────────────────────────────────────────────
/**
 * Парсит ArrayBuffer файла и возвращает метаданные.
 * @param {ArrayBuffer} arrayBuffer — только ПЕРВЫЕ байты файла (для скорости)
 * @param {string} fileName — имя файла
 * @param {string} fileExt — расширение (для проверки подмены)
 * @param {number} fileSize — полный размер файла в байтах
 * @returns {Object} метаданные
 */
function parseImageFile(arrayBuffer, fileName, fileExt, fileSize) {
  const buf = new Uint8Array(arrayBuffer);
  const realFormat = detectFormat(buf);
  const declaredExt = fileExt.toLowerCase().replace('.', '');

  const formatAliases = { jpg: 'jpeg', jpeg: 'jpeg', tif: 'tiff', tiff: 'tiff', png: 'png', bmp: 'bmp', gif: 'gif', pcx: 'pcx' };
  const declaredFormat = formatAliases[declaredExt] || declaredExt;

  let spoofed = false;
  if (realFormat && realFormat !== declaredFormat) {
    spoofed = true;
  }

  let result;
  try {
    switch (realFormat || declaredFormat) {
      case 'jpeg': result = parseJPEG(buf, fileSize); break;
      case 'png':  result = parsePNG(buf, fileSize);  break;
      case 'bmp':  result = parseBMP(buf, fileSize);  break;
      case 'gif':  result = parseGIF(buf, fileSize);  break;
      case 'tiff': result = parseTIFF(buf, fileSize); break;
      case 'pcx':  result = parsePCX(buf, fileSize);  break;
      default:
        result = { error: `Неизвестный формат (${declaredExt})` };
    }
  } catch (e) {
    result = { error: `Ошибка парсинга: ${e.message}`, damaged: 'Исключение при чтении' };
  }

  if (!result) result = { error: 'Парсер вернул null' };

  result.fileName = fileName;
  result.fileSize = fileSize;
  result.declaredExt = declaredExt;
  result.realFormat = realFormat || 'Неизвестен';
  result.spoofed = spoofed;
  if (spoofed) {
    result.damaged = `Подменённое расширение: заявлен .${declaredExt}, реальный формат — ${realFormat.toUpperCase()}`;
    result.valid = false;
  }

  return result;
}

// Экспорт для Web Worker и app.js
if (typeof module !== 'undefined') {
  module.exports = { parseImageFile, detectFormat };
}
