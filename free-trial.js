import readline from 'readline';
import { DateTime } from 'luxon';
import dotenv from 'dotenv';
import pg from 'pg';
import logger from './logger.js';

// Load environment variables
dotenv.config();

// Create database connection
const db = new pg.Pool({
  host: process.env.POSTGRES_HOST,
  port: process.env.POSTGRES_PORT,
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD
});

// Create readline interface
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const question = (query) => new Promise((resolve) => rl.question(query, resolve));

async function addFreeTrial(username, days) {
  const subscriptionDate = DateTime.now();
  const expirationDate = subscriptionDate.plus({ days });

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
      username,
      subscriptionDate.toJSDate(),
      expirationDate.toJSDate()
    ]);

    logger.info('Added free trial', {
      username,
      subscriptionDate: subscriptionDate.toISO(),
      expirationDate: expirationDate.toISO(),
      days
    });

    console.log(`Successfully added ${days}-day free trial for @${username}`);
    console.log(`Trial expires on: ${expirationDate.toLocaleString(DateTime.DATETIME_FULL)}`);

  } catch (error) {
    logger.error('Error adding free trial:', {
      error: error.message,
      username,
      days
    });
    console.error('Error adding free trial:', error.message);
  }
}

async function main() {
  try {
    const username = await question('Enter Hive username (without @): ');
    if (!username || username.length > 16) {
      throw new Error('Invalid username. Must be between 1 and 16 characters.');
    }

    const daysInput = await question('Enter number of days for free trial: ');
    const days = parseInt(daysInput);
    if (isNaN(days) || days <= 0) {
      throw new Error('Invalid number of days. Must be a positive number.');
    }

    await addFreeTrial(username, days);
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await db.end();
    rl.close();
  }
}

// Handle script interruption
process.on('SIGINT', async () => {
  console.log('\nClosing database connection...');
  await db.end();
  process.exit(0);
});

main();
