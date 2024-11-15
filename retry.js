import logger from './logger.js';

class RetryOperation {
  constructor(options = {}) {
    this.maxAttempts = options.maxAttempts || 3;
    this.delay = options.delay || 1000;
    this.backoffFactor = options.backoffFactor || 2;
    this.name = options.name || 'unnamed';
  }

  async execute(operation) {
    let lastError;
    let attempt = 1;

    while (attempt <= this.maxAttempts) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        
        if (attempt === this.maxAttempts) {
          logger.error(`${this.name} operation failed after ${attempt} attempts`, {
            error: error.message,
            attempt
          });
          throw error;
        }

        const waitTime = this.delay * Math.pow(this.backoffFactor, attempt - 1);
        logger.warn(`${this.name} operation failed, retrying in ${waitTime}ms`, {
          attempt,
          error: error.message
        });

        await new Promise(resolve => setTimeout(resolve, waitTime));
        attempt++;
      }
    }
  }
}

export default RetryOperation;
