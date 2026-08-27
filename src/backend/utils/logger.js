/**
 * Winston Logger Configuration
 */

const winston = require('winston');
const path = require('path');

/**
 * Default `http`, not `info`.
 *
 * winston's npm levels are ordered error(0) < warn(1) < info(2) < http(3) <
 * verbose(4) < debug(5), and a level only lets through what is numerically at
 * or below it. So `info` — the documented default, and what production ran —
 * silently dropped every `http` record, which is where Morgan writes: the app
 * had NO request logs in production at all, and nothing said so.
 *
 * `http` keeps them without turning on `debug`, which is deliberately noisy:
 * the reconciler logs a line per gated job per sweep there specifically to stay
 * out of the way. Debug stays opt-in via LOG_LEVEL.
 */
const logLevel = process.env.LOG_LEVEL || 'http';
const logFile = process.env.LOG_FILE || 'logs/app.log';

// Define log format
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
    let log = `${timestamp} [${level.toUpperCase()}]: ${message}`;
    if (Object.keys(meta).length) {
      log += ` ${JSON.stringify(meta)}`;
    }
    if (stack) {
      log += `\n${stack}`;
    }
    return log;
  })
);

// Create transports array
const transports = [
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      logFormat
    )
  })
];

// Files in production only. This is about WHERE the logs go, not which ones:
// every level above is emitted in both environments. In dev the console is the
// log — captured by `docker compose logs` — and writing files as well would put
// a logs/ directory inside the mounted source tree.
// Add file transport in production
if (process.env.NODE_ENV === 'production') {
  transports.push(
    new winston.transports.File({
      filename: path.resolve(process.cwd(), logFile),
      format: logFormat,
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5
    }),
    new winston.transports.File({
      filename: path.resolve(process.cwd(), 'logs/error.log'),
      level: 'error',
      format: logFormat,
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5
    })
  );
}

const logger = winston.createLogger({
  level: logLevel,
  format: logFormat,
  transports,
  exitOnError: false
});

// Add HTTP stream for Morgan
logger.stream = {
  write: (message) => logger.http(message.trim())
};

module.exports = logger;
