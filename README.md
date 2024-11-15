### Prerequisites
- Ubuntu or another Linux distro of your choice
- NodeJS (v18 or newer)
- PostgreSQL

### Install necessary packages
```
sudo apt install nodejs postgresql
```
Make sure you have at least v18 of nodejs (Run `node --version`)

### Clone Repository
```
git clone https://github.com/mp-hive/leo-subscribers.git
cd leo-subscribers

```

### Database setup
```
sudo -i -u postgres
```
Now create a user for your database
```
createuser --interactive --pwprompt db-username
```
Then create your database
```
createdb subscription_tracker --owner db-username
exit
```
Now create the database schema
```
psql -h localhost -U db-username -d subscription_tracker -f init.sql
```

### Application Setup
Create your .env file and edit it
```
cp .env.example .env
nano .env
```
Fill all the blanks in this file, i.e. your database name, your database user, your database user's password and the hive account that you would like to track.

When you're done, press Ctrl + X, then Y and Enter to save the file.

Now run the following command to install necessary packages

```
npm install
```

Everything should now be good to go. To test the application, run `node monitor-subscriptions.js`. You should get something like this:

```
$ node monitor-subscriptions.js
2024-11-15 17:44:25 [info]: Database pool initialized {"host":"localhost","port":"5432","database":"subscription_tracker","user":"db-username"}
2024-11-15 17:44:26 [info]: Health check server listening on port 3020
Starting search for transactions...
Looking for transfers to leosubscriptions:
- Memo: "subscribe:mightpossibly"
- Amount: 5.000 HBD
- Time range: 2024-10-15 to 2024-11-15
Fetched 385 operations

Valid Transfers:

Total valid transfers found: 0
Search completed
2024-11-15 17:44:29 [info]: Successfully connected to Hive network
2024-11-15 17:44:29 [info]: Real-time monitoring started
```
If everything is working as intended, you can now stop the script with `Ctrl + C`.

### Set it up as a service
First, create a new systemd service file:
```
sudo nano /etc/systemd/system/subscription-tracker.service
```
Add the following content to the file (remember to replace YOUR_USERNAME with your server username):
```
[Unit]
Description=Hive Subscription Tracker Service
After=network.target postgresql.service

[Service]
Type=simple
User=YOUR_USERNAME
WorkingDirectory=/home/YOUR_USERNAME/leo-subscribers
ExecStart=/usr/bin/node monitor-subscriptions.js
Restart=always
RestartSec=10
StandardOutput=append:/var/log/subscription-tracker/output.log
StandardError=append:/var/log/subscription-tracker/error.log

# Environment variables from .env
EnvironmentFile=/home/YOUR_USERNAME/leo-subscribers/.env

[Install]
WantedBy=multi-user.target
```
Create the log directory and set permissions:
```
sudo mkdir -p /var/log/subscription-tracker
sudo chown YOUR_USERNAME:YOUR_USERNAME /var/log/subscription-tracker
```
Enable and start the service:
```
sudo systemctl daemon-reload
sudo systemctl enable subscription-tracker
sudo systemctl start subscription-tracker
```
You can check the status of the service with:
```
sudo systemctl status subscription-tracker
```
To view the logs in real-time:
```
tail -f /var/log/subscription-tracker/output.log
```
Some useful systemd commands:
```
# Stop the service
sudo systemctl stop subscription-tracker

# Restart the service
sudo systemctl restart subscription-tracker

# View recent logs
journalctl -u subscription-tracker -n 50 --no-pager
```

### Additional recommendations:
Make sure your .env file has restricted permissions:
```
chmod 600 /home/YOUR_USERNAME/leo-subscribers/.env
```
Consider setting up log rotation to prevent the logs from growing too large:
```
sudo nano /etc/logrotate.d/subscription-tracker
```
Add this content to the file:
```
/var/log/subscription-tracker/*.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    create 0640 YOUR_USERNAME YOUR_USERNAME
}
```

---

### Free Trial Period
You can manually grant users free trial periods by running the script `free-trial.js`. It will then prompt you for a hive account name and the number of days you wish to grant access. This is also useful to add yourself to the whitelist without having to subscribe to yourself.

Example:

```
$ node free-trial.js 
Enter Hive username (without @): mightpossibly
Enter number of days for free trial (0 to expire immediately): 7
2024-11-15 18:16:16 [info]: Added free trial {"username":"mightpossibly","subscriptionDate":"2024-11-15T18:16:16.085+01:00","expirationDate":"2024-11-22T18:16:16.085+01:00","days":7}
Successfully added 7-day free trial for @mightpossibly
Trial expires on: November 22, 2024 at 6:16 PM GMT+1
```

### Inspect your database
To view data in your database, run:
```
psql -h localhost -p 5432 -U db-username -d subscription_tracker -W
```
To view a table showing all active and inactive subscriptions, run:
```
SELECT * FROM subscriptions;
```
Hotkey `Ctrl + Z` to exit the database