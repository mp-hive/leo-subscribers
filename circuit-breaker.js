class CircuitBreaker {
    constructor(options = {}) {
      this.failureThreshold = options.failureThreshold || 5;
      this.resetTimeout = options.resetTimeout || 60000; // 1 minute
      this.failureCount = 0;
      this.isOpen = false;
      this.lastFailureTime = null;
      this.name = options.name || 'unnamed';
    }
  
    async execute(operation) {
      if (this.isOpen) {
        if (Date.now() - this.lastFailureTime >= this.resetTimeout) {
          this.reset();
        } else {
          throw new Error(`Circuit breaker is open for ${this.name}`);
        }
      }
  
      try {
        const result = await operation();
        this.success();
        return result;
      } catch (error) {
        this.failure();
        throw error;
      }
    }
  
    success() {
      this.failureCount = 0;
      this.isOpen = false;
    }
  
    failure() {
      this.failureCount++;
      this.lastFailureTime = Date.now();
      
      if (this.failureCount >= this.failureThreshold) {
        this.isOpen = true;
      }
    }
  
    reset() {
      this.failureCount = 0;
      this.isOpen = false;
      this.lastFailureTime = null;
    }
  
    getState() {
      return {
        isOpen: this.isOpen,
        failureCount: this.failureCount,
        lastFailureTime: this.lastFailureTime
      };
    }
  }
  
  export default CircuitBreaker;
  