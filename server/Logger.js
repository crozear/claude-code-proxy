const { Transform } = require('stream');

class Logger {
  static init(config) {
    this.config = config;
  }

  static getLogLevel() {
    const levels = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3, TRACE: 4 };
    return levels[this.config?.log_level] || 2;
  }

  static debug(...args) {
    if (this.getLogLevel() >= 3) {
      console.log('DEBUG:', ...args);
    }
  }

  static trace(...args) {
    if (this.getLogLevel() >= 4) {
      console.log('TRACE:', ...args);
    }
  }

  static info(...args) {
    console.log('INFO:', ...args);
  }

  static warn(...args) {
    console.warn('WARN:', ...args);
  }

  static error(...args) {
    console.error('ERROR:', ...args);
  }

  // Clamp a value to a single, bounded log line. Docker's json-file/local
  // driver splits any log line longer than 16384 bytes and stamps the
  // continuation with a fresh RFC3339Nano timestamp — which is how a Docker
  // timestamp ended up smeared into a dumped request/response. Keep the
  // default well under 16 KB so a prefix + multibyte chars still fit.
  static truncate(value, max = 16000) {
    const str = typeof value === 'string' ? value : String(value);
    if (str.length <= max) return str;
    return `${str.slice(0, max)}… [+${str.length - max} more chars]`;
  }

  static createDebugStream(label = 'Stream chunk', textExtractor = null) {
    if (this.getLogLevel() < 3) {
      return new Transform({
        transform(chunk, encoding, callback) {
          callback(null, chunk);
        }
      });
    }

    // Keep every emitted line a single, prefixed, newline-terminated record
    // that stays under Docker's 16 KB split. The old version echoed raw,
    // newline-less response tokens straight to process.stdout, so Docker
    // buffered the whole reply into one giant line and chopped it every
    // 16384 bytes — injecting a timestamp into the echoed copy and smearing
    // it across the INFO:/DEBUG: lines. We now accumulate and emit one framed
    // summary at end-of-stream instead.
    const logLevel = this.getLogLevel();
    const PREVIEW_LIMIT = 2000;
    let streamingText = '';
    let thinkingText = '';
    let hasStartedStreaming = false;

    return new Transform({
      transform(chunk, encoding, callback) {
        try {
          const chunkStr = chunk.toString();

          // TRACE: every chunk, but bounded so one chunk can't trip the split.
          if (logLevel >= 4) {
            Logger.trace(`${label} (${chunkStr.length} bytes): ${Logger.truncate(chunkStr, PREVIEW_LIMIT)}`);
          }

          if (textExtractor) {
            const result = textExtractor(chunk);
            if (result?.text || result?.thinking) {
              if (!hasStartedStreaming) {
                Logger.debug(`${label} streaming started`);
                hasStartedStreaming = true;
              }
              if (result.text) streamingText += result.text;
              if (result.thinking) thinkingText += result.thinking;
            }
          } else if (logLevel === 3) {
            // DEBUG without an extractor: one framed, bounded line per chunk.
            Logger.debug(`${label} (${chunkStr.length} bytes): ${Logger.truncate(chunkStr, PREVIEW_LIMIT)}`);
          }
        } catch (error) {
          Logger.debug(`${label} (failed to decode chunk)`);
        }
        callback(null, chunk);
      },

      flush(callback) {
        // One framed summary in place of the raw token echo.
        if (hasStartedStreaming) {
          if (thinkingText) {
            Logger.debug(`${label} thinking (${thinkingText.length} chars): ${Logger.truncate(thinkingText, PREVIEW_LIMIT)}`);
          }
          Logger.debug(`${label} response (${streamingText.length} chars): ${Logger.truncate(streamingText, PREVIEW_LIMIT)}`);
          Logger.debug(`${label} streaming complete`);
        }
        callback();
      }
    });
  }

}

module.exports = Logger;