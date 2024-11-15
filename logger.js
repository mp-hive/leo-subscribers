import winston from 'winston';
import 'winston-daily-rotate-file';

const { createLogger, format, transports } = winston;
const { combine, timestamp, printf, errors, colorize } = format;

// Custom format for logs
const logFormat = printf(({ level, message, timestamp, stack, ...metadata }) => {
  let log = `${timestamp} [${level}]: ${message}`;
  
  // Add metadata if exists
  if (Object.keys(metadata).length > 0) {
    log += ` ${JSON.stringify(metadata)}`;
  }
  
  // Add stack trace for errors
  if (stack) {
    log += `\n${stack}`;
  }
  
  return log;
});

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    errors({ stack: true }),
    logFormat
  ),
  transports: [
    // Console logging
    new transports.Console({
      format: combine(
        colorize(),
        logFormat
      )
    }),
    
    // Rotating file for all logs
    new transports.DailyRotateFile({
      filename: 'logs/subscription-tracker-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '14d',
      zippedArchive: true
    }),
    
    // Separate file for errors
    new transports.DailyRotateFile({
      filename: 'logs/subscription-tracker-error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '14d',
      level: 'error',
      zippedArchive: true
    })
  ]
});

// Create a stream for Morgan (if we add HTTP logging later)
logger.stream = {
  write: (message) => logger.info(message.trim())
};

export default logger;
