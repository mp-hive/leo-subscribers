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
    this.lastConnectionState = false; // Track connection state changes

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

    // Only log when connection state changes
    setInterval(() => {
      if (this.isConnected !== this.lastConnectionState) {
        logger.info('Connection state changed', { 
          connected: this.isConnected,
          attempts: this.reconnectAttempts
        });
        this.lastConnectionState = this.isConnected;
      }
    }, 60000); // Check every minute instead of every 30 seconds
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
  
    // Create observers for both accounts
    const subscriptionObserver = this.bot.observe.accountOperations(process.env.SUBSCRIPTION_PAYMENT_ACCOUNT);
    const aiObserver = this.bot.observe.accountOperations(process.env.AI_PAYMENT_ACCOUNT);
    
    const observerHandler = {
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
    };
  
    // Subscribe both observers
    subscriptionObserver.subscribe(observerHandler);
    aiObserver.subscribe(observerHandler);
    
    logger.info('Real-time monitoring started for all accounts');
  }
  
  async processOperation(operation) {
    return this.retry.execute(async () => {
      // Skip if not an array operation
      if (!Array.isArray(operation.op)) {
        return;
      }
  
      const [opType, opData] = operation.op;
      
      // Check both regular and recurring transfers
      if ((opType === 'transfer' || opType === 'fill_recurrent_transfer') && 
          (opData.to === process.env.SUBSCRIPTION_PAYMENT_ACCOUNT || 
           opData.to === process.env.AI_PAYMENT_ACCOUNT)) {
        
        const [amountValue, symbol] = opData.amount.split(' ');
        const transferAmount = parseFloat(amountValue);
  
        logger.debug(`${opType} detected:`, {
          from: opData.from,
          to: opData.to,
          amount: opData.amount,
          memo: opData.memo,
          type: opType
        });
  
        const transformedTransfer = {
          from: opData.from,
          to: opData.to,
          amount: {
            amount: transferAmount,
            symbol: 'HBD'
          },
          memo: opData.memo,
          timestamp: operation.timestamp
        };
  
        // Handle AI Summaries transfers
        if (opData.to === process.env.AI_PAYMENT_ACCOUNT && 
            symbol === 'HBD') {
          if (transferAmount === Number(process.env.AI_SUBSCRIPTION_FULL_AMOUNT) || 
              transferAmount === Number(process.env.AI_SUBSCRIPTION_MINI_AMOUNT)) {
            try {
              await processSubscriptionTransfer(transformedTransfer);
            } catch (error) {
              logger.error('Failed to process AI subscription:', {
                error: error.message,
                transfer: transformedTransfer
              });
            }
          }
        }
        
        // Handle regular subscription transfers
        else if (opData.to === process.env.SUBSCRIPTION_PAYMENT_ACCOUNT && 
                 transferAmount === Number(process.env.SUBSCRIPTION_AMOUNT) && 
                 symbol === 'HBD' &&
                 opData.memo.toLowerCase() === `subscribe:${process.env.SUBSCRIPTION_ACCOUNT.toLowerCase()}`) {
          try {
            await processSubscriptionTransfer(transformedTransfer);
          } catch (error) {
            logger.error('Failed to process subscription:', {
              error: error.message,
              transfer: transformedTransfer
            });
          }
        }
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

  // Define the accounts and amounts to check
  const checkParams = [
    {
      account: process.env.SUBSCRIPTION_PAYMENT_ACCOUNT,
      amount: process.env.SUBSCRIPTION_AMOUNT,
      requireMemo: true,
      memoText: `subscribe:${process.env.SUBSCRIPTION_ACCOUNT}`
    },
    {
      account: process.env.AI_PAYMENT_ACCOUNT,
      amount: process.env.AI_SUBSCRIPTION_FULL_AMOUNT,
      requireMemo: false
    },
    {
      account: process.env.AI_PAYMENT_ACCOUNT,
      amount: process.env.AI_SUBSCRIPTION_MINI_AMOUNT,
      requireMemo: false
    }
  ];

  for (const params of checkParams) {
    console.log(`\nLooking for transfers to ${params.account}:`);
    if (params.requireMemo) {
      console.log(`- Memo: "${params.memoText}"`);
    }
    const formattedAmount = Number(params.amount).toFixed(3);
    console.log(`- Amount: ${formattedAmount} HBD`);
    console.log('- Time range:', startDate.toISODate(), 'to', endDate.toISODate());

    try {
      const response = await fetch(`https://${process.env.HIVE_API_NODE}`, {
        method: 'POST',
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'condenser_api.get_account_history',
          params: [params.account, -1, 1000],
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
        const [trx_id, { op, timestamp }] = operation;
        
        // Skip if not an array operation
        if (!Array.isArray(op)) continue;
        
        const [opType, opData] = op;
        
        // Check both regular and recurring transfers
        if ((opType === 'transfer' || opType === 'fill_recurrent_transfer') && 
            opData.to === params.account) {
          
          const [amountValue, symbol] = opData.amount.split(' ');
          const transferAmount = parseFloat(amountValue);
          
          const isValidTransfer = 
            transferAmount === Number(params.amount) &&
            symbol === 'HBD' &&
            DateTime.fromISO(timestamp) >= startDate &&
            DateTime.fromISO(timestamp) <= endDate;

          // Additional memo check only if required
          const isValidMemo = params.requireMemo ? 
            opData.memo.toLowerCase() === params.memoText.toLowerCase() : 
            true;

          if (isValidTransfer && isValidMemo) {
            const transformedTransfer = {
              from: opData.from,
              to: opData.to,
              amount: {
                amount: transferAmount,
                symbol: 'HBD'
              },
              memo: opData.memo,
              timestamp
            };

            validTransfers.push(transformedTransfer);
          }
        }
      }

      console.log('\nValid Transfers:');
      for (const transfer of validTransfers) {
        console.log(transfer);
        const result = await processSubscriptionTransfer(transfer);
        if (!result) {
          logger.error('Failed to process transfer:', { transfer });
        }
      }
      console.log('Total valid transfers found:', validTransfers.length);

    } catch (error) {
      console.error('Error fetching transactions:', error);
      throw error;
    }
  }

  console.log('\nSearch completed');
}
  
async function processSubscriptionTransfer(transfer) {
  const {
    from: sender,
    to: recipient,
    amount: { amount: value, symbol },
    memo
  } = transfer;

  // Handle AI Summaries transfers
  if (recipient === process.env.AI_PAYMENT_ACCOUNT && symbol === 'HBD') {
    let days = 0;
    if (value === Number(process.env.AI_SUBSCRIPTION_FULL_AMOUNT)) {
      days = Number(process.env.AI_SUBSCRIPTION_FULL_DAYS);
      logger.info('AI Summaries full subscription payment received', {
        sender,
        amount: value,
        days
      });
      return await addSubscription(sender, days);
    } else if (value === Number(process.env.AI_SUBSCRIPTION_MINI_AMOUNT)) {
      days = Number(process.env.AI_SUBSCRIPTION_MINI_DAYS);
      logger.info('AI Summaries mini subscription payment received', {
        sender,
        amount: value,
        days
      });
      return await addSubscription(sender, days);
    }
  }

  // Handle original subscription logic
  if (recipient === process.env.SUBSCRIPTION_PAYMENT_ACCOUNT && 
      value === Number(process.env.SUBSCRIPTION_AMOUNT) && 
      symbol === 'HBD') {
    
    const memoMatch = memo.match(/^subscribe:(\w+)$/);
    if (!memoMatch) {
      return false;
    }

    const subscribingAccount = memoMatch[1].toLowerCase();
    if (subscribingAccount !== process.env.SUBSCRIPTION_ACCOUNT.toLowerCase()) {
      return false;
    }

    logger.info('Standard subscription payment received', {
      sender,
      amount: value,
      days: 31
    });

    return await addSubscription(sender, 31);
  }

  return false;
}

async function addSubscription(username, days) {
  const subscriptionDate = new Date();
  const expirationDate = new Date(subscriptionDate);
  expirationDate.setDate(expirationDate.getDate() + days);

  try {
    // Check if the user already has an active subscription
    const existingSubscription = await db.query(
      'SELECT subscription_date, expiration_date FROM subscriptions WHERE username = $1',
      [username]
    );

    if (existingSubscription.rows.length > 0) {
      const currentSubscriptionDate = new Date(existingSubscription.rows[0].subscription_date);
      const currentExpirationDate = new Date(existingSubscription.rows[0].expiration_date);

      // Only update the expiration_date if the new subscription_date is after the current expiration_date
      if (subscriptionDate > currentExpirationDate) {
        expirationDate.setDate(subscriptionDate.getDate() + days);
      } else {
        // If the subscription is still active, do not add additional days
        logger.info('Subscription is still active; no additional days added', {
          username,
          currentExpirationDate,
          newSubscriptionDate: subscriptionDate
        });
        return true; // Return true to indicate no error, but no action was taken
      }
    }

    // Insert or update the subscription
    const query = `
      INSERT INTO subscriptions (username, subscription_date, expiration_date)
      VALUES ($1, $2, $3)
      ON CONFLICT (username) 
      DO UPDATE SET 
        subscription_date = $2,
        expiration_date = $3,
        date_updated = CURRENT_TIMESTAMP,
        active_subscription = TRUE
    `;
    
    await db.query(query, [username, subscriptionDate, expirationDate]);
    
    logger.info('Subscription added or updated successfully', {
      username,
      subscriptionDate,
      expirationDate
    });
    
    return true;
  } catch (error) {
    logger.error('Error adding subscription:', {
      error: error.message,
      username,
      days
    });
    return false;
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

    // Create monitor first
    monitor = new HiveMonitor();
    await monitor.connect();  // This initializes the client
    global.monitor = monitor;

    // Now pass the client to findTransactions
    await findTransactions(monitor.client);
    
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
    await monitor.startMonitoring();
  } catch (error) {
    console.error('Error in main execution:', error);
    if (monitor) {
      await monitor.stop();
    }
    throw error;
  }
}

main();