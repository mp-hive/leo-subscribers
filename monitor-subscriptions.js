import dotenv from 'dotenv';
import pg from 'pg';
import { DateTime } from 'luxon';
import WorkerBee from "@hiveio/workerbee";
import fetch from 'node-fetch';
import db from './db.js';
import HealthCheck from './health.js';
import logger from './logger.js';
import CircuitBreaker from './circuit-breaker.js';
import RetryOperation from './retry.js';

// Load environment variables
dotenv.config();

// Database configuration
const pool = new pg.Pool({
  host: process.env.POSTGRES_HOST,
  port: process.env.POSTGRES_PORT,
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD
});

// Constants from environment
const SUBSCRIPTION_PAYMENT_ACCOUNT = process.env.SUBSCRIPTION_PAYMENT_ACCOUNT;
const SUBSCRIPTION_AMOUNT = process.env.SUBSCRIPTION_AMOUNT;
const SUBSCRIPTION_ACCOUNT = process.env.SUBSCRIPTION_ACCOUNT;
const HIVE_API_NODE = process.env.HIVE_API_NODE;

class HiveMonitor {
  constructor() {
    this.bot = null;
    this.observer = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 5000; // 5 seconds

    this.circuitBreaker = new CircuitBreaker({
      name: 'hive-connection',
      failureThreshold: 3,
      resetTimeout: 60000 // 1 minute
    });

    this.retry = new RetryOperation({
      name: 'hive-connection',
      maxAttempts: 5,
      delay: 5000,
      backoffFactor: 1.5
    });
  }

  async connect() {
    if (this.isConnected) {
      return;
    }

    await this.circuitBreaker.execute(async () => {
      await this.retry.execute(async () => {
        this.bot = new WorkerBee();
        
        this.bot.on("error", (error) => {
          logger.error('WorkerBee error:', { error: error.message });
          this.handleDisconnect();
        });

        this.bot.on("disconnect", () => {
          logger.warn('WorkerBee disconnected');
          this.handleDisconnect();
        });

        await this.bot.start();
        this.isConnected = true;
        this.reconnectAttempts = 0;
        logger.info('Successfully connected to Hive network');
      });
    });
  }

  async handleDisconnect() {
    this.isConnected = false;
    this.observer = null;

    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      logger.info(`Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
      await new Promise(resolve => setTimeout(resolve, this.reconnectDelay));
      await this.connect();
    } else {
      logger.error('Max reconnection attempts reached');
      throw new Error('Failed to maintain Hive connection');
    }
  }

  async startMonitoring() {
    if (!this.isConnected || !this.bot) {
      await this.connect();
    }

    this.observer = this.bot.observe.accountOperations(SUBSCRIPTION_PAYMENT_ACCOUNT);
    
    this.observer.subscribe({
      next: async (operation) => {
        try {
          await this.processOperation(operation);
        } catch (error) {
          logger.error('Error processing operation:', { error: error.message });
        }
      },
      error: (error) => {
        logger.error('Observer error:', { error: error.message });
        this.handleDisconnect();
      },
      complete: () => {
        logger.info('Observer completed');
      }
    });
    
    logger.info('Real-time monitoring started');
  }

  async processOperation(operation) {
    return this.retry.execute(async () => {
      if (operation[0] === 'transfer' && 
          operation[1].to === SUBSCRIPTION_PAYMENT_ACCOUNT &&
          operation[1].amount.includes(`${SUBSCRIPTION_AMOUNT}.000 HBD`) &&
          operation[1].memo.toLowerCase() === `subscribe:${SUBSCRIPTION_ACCOUNT}`) {
        
        const transfer = {
          from: operation[1].from,
          amount: operation[1].amount,
          timestamp: operation[1].timestamp
        };
        
        await processSubscriptionTransfer(transfer);
        logger.info('Successfully processed transfer', { 
          from: transfer.from, 
          amount: transfer.amount 
        });
      }
    });
  }

  async stop() {
    try {
      this.isRunning = false;
      if (this.client) {
        // Properly close the connection if it exists
        await this.client.disconnect();
        this.client = null;
      }
      logger.info('Hive monitor stopped successfully');
    } catch (error) {
      logger.error('Error stopping Hive monitor:', { 
        error: error.message,
        stack: error.stack 
      });
      // Don't rethrow the error to allow cleanup to continue
    }
  }

  getState() {
    return {
      isConnected: this.isConnected,
      reconnectAttempts: this.reconnectAttempts,
      circuitBreakerState: this.circuitBreaker.getState(),
      lastError: this.lastError
    };
  }
}

export default HiveMonitor;

async function findTransactions() {
    console.log('Starting search for transactions...');
    
    const endDate = DateTime.now();
    const startDate = endDate.minus({ days: 31 });
    
    console.log('Looking for transfers to', SUBSCRIPTION_PAYMENT_ACCOUNT + ':');
    console.log(`- Memo: "subscribe:${SUBSCRIPTION_ACCOUNT}"`);
    console.log(`- Amount: ${SUBSCRIPTION_AMOUNT}.000 HBD`);
    console.log('- Time range:', startDate.toISODate(), 'to', endDate.toISODate());
  
    try {
      const response = await fetch(`https://${HIVE_API_NODE}`, {
        method: 'POST',
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'condenser_api.get_account_history',
          params: [SUBSCRIPTION_PAYMENT_ACCOUNT, -1, 1000],
          id: 1
        }),
        headers: { 'Content-Type': 'application/json' }
      });
  
      const data = await response.json();
      if (data.error) {
        throw new Error(data.error.message);
      }
  
      if (!Array.isArray(data.result)) {
        throw new Error('Unexpected API response format');
      }
  
      console.log(`Fetched ${data.result.length} operations`);
  
      const validTransfers = [];
      
      for (const operation of data.result) {
        // Each operation is an array where operation[1] contains the actual operation data
        const [trx_id, { op, timestamp }] = operation;
        
        // op[0] is operation type, op[1] contains operation data
        const [op_type, op_data] = op;
        
        if (op_type === 'transfer') {
          const { from, to, amount, memo } = op_data;
          const txTimestamp = DateTime.fromISO(timestamp);
          
          if (to === SUBSCRIPTION_PAYMENT_ACCOUNT &&
              amount === `${SUBSCRIPTION_AMOUNT}.000 HBD` &&
              memo.toLowerCase() === `subscribe:${SUBSCRIPTION_ACCOUNT}` &&
              txTimestamp >= startDate &&
              txTimestamp <= endDate) {
            
            validTransfers.push({
              from,
              amount,
              timestamp,
              block_num: trx_id
            });
          }
        }
      }
  
      console.log('\nValid Transfers:');
      for (const transfer of validTransfers) {
        console.log(transfer);
        await processSubscriptionTransfer(transfer);
      }
  
      console.log('\nTotal valid transfers found:', validTransfers.length);
      console.log('Search completed');
      
    } catch (error) {
      console.error('Error fetching transactions:', error);
      throw error;
    }
  }
  

  async function processSubscriptionTransfer(transfer) {
    const { from, amount, timestamp } = transfer;
    const subscriptionDate = DateTime.fromISO(timestamp);
    const expirationDate = subscriptionDate.plus({ days: 31 });
  
    try {
      const query = `
        INSERT INTO subscriptions (username, subscription_date, expiration_date)
        VALUES ($1, $2, $3)
        ON CONFLICT (username) 
        DO UPDATE SET 
          subscription_date = EXCLUDED.subscription_date,
          expiration_date = EXCLUDED.expiration_date,
          date_updated = CURRENT_TIMESTAMP,
          active_subscription = TRUE
        WHERE subscriptions.expiration_date < EXCLUDED.expiration_date
      `;
      
      await db.query(query, [
        from, 
        subscriptionDate.toJSDate(),
        expirationDate.toJSDate()
      ]);
      
      logger.info('Processed subscription', { 
        username: from,
        subscriptionDate: subscriptionDate.toISO(),
        expirationDate: expirationDate.toISO(),
        amount: amount
      });

    } catch (error) {
      logger.error('Error processing subscription:', { 
        error: error.message,
        username: from,
        code: error.code,
        timestamp: timestamp
      });

      if (error.code === '42P10') {
        logger.error('Database schema needs to be updated with UNIQUE constraint on username');
      }
    }
}


// Add shutdown handling
async function shutdown() {
  logger.info('Shutting down gracefully...');
  try {
    if (global.monitor) {
      await global.monitor.stop();
    }
    if (global.healthCheck) {
      await global.healthCheck.stop();
    }
    await db.end();
    logger.info('Cleanup completed');
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown:', { error: error.message });
    process.exit(1);
  }
}

// Handle process termination
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

async function startRealTimeMonitoring() {
  const monitor = new HiveMonitor();
  await monitor.startMonitoring();
  return monitor; // Return the monitor instance for cleanup
}

async function checkExpiredSubscriptions() {
  try {
    const query = `
      UPDATE subscriptions 
      SET active_subscription = FALSE 
      WHERE expiration_date < CURRENT_TIMESTAMP 
      AND active_subscription = TRUE
      RETURNING username
    `;
    
    const result = await db.query(query);
    if (result.rows.length > 0) {
      logger.info('Deactivated subscriptions', {
        count: result.rows.length,
        usernames: result.rows.map(row => row.username)
      });
    } else {
      logger.debug('No subscriptions to deactivate');
    }

    // Update health check timestamp after successful check
    global.healthCheck?.updateLastCheck();
  } catch (error) {
    logger.error('Error checking expired subscriptions:', { 
      error: error.message,
      stack: error.stack
    });
  }
}


async function startPeriodicChecks() {
  // Check every hour
  setInterval(checkExpiredSubscriptions, 60 * 60 * 1000);
  // Run immediate check on startup
  await checkExpiredSubscriptions();
}

async function main() {
  let monitor = null;
  
  try {
    // Initialize health check
    global.healthCheck = new HealthCheck();
    await global.healthCheck.start();

    // First, process historical transactions
    await findTransactions();
    
    // Start periodic checks for expired subscriptions
    const checkInterval = 60 * 60 * 1000; // 1 hour
    const periodicCheck = async () => {
      try {
        await checkExpiredSubscriptions();
      } catch (error) {
        console.error('Error in periodic check:', error);
      }
    };

    setInterval(periodicCheck, checkInterval);
    await periodicCheck(); // Initial check
    
    // Then start real-time monitoring
    monitor = await startRealTimeMonitoring();
    global.monitor = monitor; // Make monitor globally accessible for health checks
  } catch (error) {
    console.error('Error in main execution:', error);
    if (monitor) {
      await monitor.stop();
    }
    throw error;
  }
}


main();
