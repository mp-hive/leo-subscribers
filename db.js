import pg from 'pg';
import dotenv from 'dotenv';
import logger from './logger.js';
import CircuitBreaker from './circuit-breaker.js';
import RetryOperation from './retry.js';

dotenv.config();

const { Pool } = pg;

class Database {
  constructor() {
    this.pool = new Pool({
      host: process.env.POSTGRES_HOST,
      port: process.env.POSTGRES_PORT,
      database: process.env.POSTGRES_DB,
      user: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });

    this.circuitBreaker = new CircuitBreaker({
        name: 'database',
        failureThreshold: 5,
        resetTimeout: 30000 // 30 seconds
    });
  
    this.retry = new RetryOperation({
        name: 'database',
        maxAttempts: 3,
        delay: 1000,
        backoffFactor: 2
    });

    // Handle pool errors
    this.pool.on('error', (err, client) => {
      logger.error('Unexpected error on idle client', {
        error: err.message,
        stack: err.stack
      });
    });

    // Log pool creation
    logger.info('Database pool initialized', {
      host: process.env.POSTGRES_HOST,
      port: process.env.POSTGRES_PORT,
      database: process.env.POSTGRES_DB,
      user: process.env.POSTGRES_USER
    });
  }

  async query(text, params) {
    return this.circuitBreaker.execute(async () => {
      return this.retry.execute(async () => {
        const start = Date.now();
        try {
          const result = await this.pool.query(text, params);
          const duration = Date.now() - start;
          logger.debug('Executed query', { text, duration, rows: result.rowCount });
          return result;
        } catch (error) {
          logger.error('Database query error:', { error: error.message, query: text });
          throw error;
        }
      });
    });
  }

  async end() {
    try {
      await this.pool.end();
      logger.info('Database pool has ended');
    } catch (error) {
      logger.error('Error closing database pool:', {
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  // Helper method to check database connection
  async checkConnection() {
    try {
      await this.query('SELECT 1');
      logger.info('Database connection check successful');
      return true;
    } catch (error) {
      logger.error('Database connection check failed:', {
        error: error.message,
        stack: error.stack
      });
      return false;
    }
  }
}

const db = new Database();
export default db;
