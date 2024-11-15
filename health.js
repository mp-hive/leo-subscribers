import express from 'express';
import logger from './logger.js';
import db from './db.js';

class HealthCheck {
  constructor() {
    this.app = express();
    this.port = process.env.HEALTH_CHECK_PORT || 3020;
    this.lastSuccessfulCheck = Date.now();
    this.server = null;
    this.setupRoutes();
  }

  setupRoutes() {
    this.app.get('/health', async (req, res) => {
      try {
        // Check DB connection
        await db.query('SELECT 1');
        
        // Check if our periodic checks are running
        const timeSinceLastCheck = Date.now() - this.lastSuccessfulCheck;
        if (timeSinceLastCheck > 120 * 60 * 1000) { // 2 hours
          throw new Error('Periodic checks may be stalled');
        }

        // Check Hive connection status
        if (!global.monitor?.isConnected) {
          throw new Error('Hive connection is not established');
        }

        res.status(200).json({
          status: 'healthy',
          lastCheck: new Date(this.lastSuccessfulCheck).toISOString(),
          dbStatus: 'connected',
          hiveStatus: 'connected'
        });
      } catch (error) {
        logger.error('Health check failed:', { error: error.message });
        res.status(503).json({
          status: 'unhealthy',
          error: error.message,
          timestamp: new Date().toISOString()
        });
      }
    });

    // Detailed status endpoint
    this.app.get('/status', async (req, res) => {
      try {
        const dbState = db.circuitBreaker.getState();
        const hiveState = global.monitor?.circuitBreaker.getState();
        
        // Get subscription statistics
        const dbResult = await db.query(
          'SELECT COUNT(*) as total, SUM(CASE WHEN active_subscription THEN 1 ELSE 0 END) as active FROM subscriptions'
        );

        res.status(200).json({
          uptime: process.uptime(),
          lastCheck: new Date(this.lastSuccessfulCheck).toISOString(),
          database: {
            connected: !dbState.isOpen,
            failures: dbState.failureCount,
            lastFailure: dbState.lastFailureTime ? new Date(dbState.lastFailureTime).toISOString() : null,
            statistics: {
              totalSubscriptions: parseInt(dbResult.rows[0].total),
              activeSubscriptions: parseInt(dbResult.rows[0].active)
            }
          },
          hive: {
            connected: global.monitor?.isConnected || false,
            failures: hiveState?.failureCount || 0,
            lastFailure: hiveState?.lastFailureTime ? new Date(hiveState.lastFailureTime).toISOString() : null,
            reconnectAttempts: global.monitor?.reconnectAttempts || 0
          },
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        logger.error('Status check failed:', { error: error.message });
        res.status(500).json({
          status: 'error',
          error: error.message,
          timestamp: new Date().toISOString()
        });
      }
    });

    // Debug endpoint (only available in development)
    if (process.env.NODE_ENV !== 'production') {
      this.app.get('/debug', async (req, res) => {
        try {
          res.status(200).json({
            env: {
              nodeEnv: process.env.NODE_ENV,
              healthCheckPort: this.port
            },
            process: {
              uptime: process.uptime(),
              memoryUsage: process.memoryUsage(),
              cpuUsage: process.cpuUsage()
            },
            database: {
              circuitBreaker: db.circuitBreaker.getState(),
              poolStatus: db.pool.totalCount ? {
                totalConnections: db.pool.totalCount,
                idleConnections: db.pool.idleCount,
                waitingClients: db.pool.waitingCount
              } : 'Not available'
            },
            hive: {
              circuitBreaker: global.monitor?.circuitBreaker.getState(),
              connectionStatus: {
                isConnected: global.monitor?.isConnected || false,
                reconnectAttempts: global.monitor?.reconnectAttempts || 0
              }
            }
          });
        } catch (error) {
          logger.error('Debug info failed:', { error: error.message });
          res.status(500).json({
            status: 'error',
            error: error.message
          });
        }
      });
    }
  }

  updateLastCheck() {
    this.lastSuccessfulCheck = Date.now();
    logger.debug('Health check timestamp updated');
  }

  async start() {
    return new Promise((resolve) => {
      this.server = this.app.listen(this.port, () => {
        logger.info(`Health check server listening on port ${this.port}`);
        resolve();
      });
    });
  }

  async stop() {
    return new Promise((resolve, reject) => {
      if (this.server) {
        this.server.close((err) => {
          if (err) {
            logger.error('Error closing health check server:', { error: err.message });
            reject(err);
          } else {
            logger.info('Health check server stopped');
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  }
}

export default HealthCheck;
