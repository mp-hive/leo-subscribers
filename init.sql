CREATE TABLE subscriptions (
    id SERIAL PRIMARY KEY,
    username VARCHAR(16) NOT NULL UNIQUE,  -- Added UNIQUE constraint
    subscription_date TIMESTAMP NOT NULL,
    expiration_date TIMESTAMP NOT NULL,
    date_updated TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    active_subscription BOOLEAN NOT NULL DEFAULT TRUE
);

-- Index for faster queries
CREATE INDEX idx_username ON subscriptions(username);
CREATE INDEX idx_expiration ON subscriptions(expiration_date);
