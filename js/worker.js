/**
 * worker.js — Web Worker для многопоточной обработки файлов.
 * Запускается в отдельном потоке. Не блокирует UI.
 *
 * Протокол сообщений:
 *   Входящие:  { type: 'PROCESS_BATCH', files: [{name, ext, size, buffer}], batchIndex }
 *   Исходящие: { type: 'BATCH_DONE', results: [...], batchIndex }
 *              { type: 'ERROR', message }
 */

'use strict';

// Импортируем парсеры (importScripts работает в Web Worker)
importScripts('./parsers.js');

self.onmessage = function(e) {
  const { type, files, batchIndex } = e.data;

  if (type === 'PROCESS_BATCH') {
    const results = [];
    for (const file of files) {
      try {
        const meta = parseImageFile(file.buffer, file.tail, file.name, file.ext, file.size);
        results.push(meta);
      } catch (err) {
        results.push({
          fileName: file.name,
          fileSize: file.size,
          error: `Критическая ошибка: ${err.message}`,
          damaged: 'Неожиданное исключение',
          valid: false,
          realFormat: 'N/A',
          declaredExt: file.ext,
        });
      }
    }
    self.postMessage({ type: 'BATCH_DONE', results, batchIndex });
  }
};
