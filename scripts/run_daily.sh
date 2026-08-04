#!/bin/bash

# Set up environment variables
export PATH=$PATH:/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin

# Ensure TZ is set
export TZ=${TZ}

# Change directory to the application directory
cd /usr/src/microsoftrewardspilot

# Prevent overlapping runs (cron can fire again while a previous run is still going).
# Acquire a non-blocking exclusive lock; if another run already holds it, exit immediately.
exec 9>/tmp/microsoftrewardspilot.lock
if ! flock -n 9; then
    echo "Another MicrosoftRewardsPilot run is already in progress, exiting."
    exit 0
fi

# Define the minimum and maximum wait times in seconds.
# A wide window matters: cron fires at fixed wall-clock hours, so this random sleep is what keeps the
# actual run start from clustering into the same few minutes every day (an easy server-side tell).
MINWAIT=$((3*60))  # 3 minutes
MAXWAIT=$((85*60)) # 85 minutes

# Calculate a random sleep time within the specified range
SLEEPTIME=$((MINWAIT + RANDOM % (MAXWAIT - MINWAIT)))

# Convert the sleep time to minutes for logging
SLEEP_MINUTES=$((SLEEPTIME / 60))

# Log the sleep duration
echo "Sleeping for $SLEEP_MINUTES minutes ($SLEEPTIME seconds)..."

# Sleep for the calculated time
sleep $SLEEPTIME

# Log the start of the script
echo "Starting script..."

# Execute the Node.js script directly
npm run start
