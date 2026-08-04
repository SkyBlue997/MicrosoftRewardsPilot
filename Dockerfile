# Use an official Node.js runtime as a base image
FROM node:18

# Set the working directory in the container
WORKDIR /usr/src/microsoftrewardspilot

# Install necessary dependencies for Playwright, cron, and anti-detection
RUN apt-get update && apt-get install -y \
    jq \
    cron \
    gettext-base \
    xvfb \
    libgbm-dev \
    libnss3 \
    libasound2 \
    libxss1 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    tzdata \
    wget \
    # Additional fonts/libraries for Chromium rendering
    fonts-liberation \
    fonts-dejavu-core \
    fonts-freefont-ttf \
    fonts-noto-color-emoji \
    libdrm2 \
    libxrandr2 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libcairo-gobject2 \
    libgtk-3-0 \
    libgdk-pixbuf2.0-0 \
    libpangocairo-1.0-0 \
    libasound2-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy all files to the working directory
COPY . .

# Install dependencies, set permissions, and build the script
RUN npm install && \
    chmod -R 755 /usr/src/microsoftrewardspilot/node_modules && \
    npm run pre-build && \
    npm run build

# Copy cron file to cron directory
COPY scripts/crontab.template /etc/cron.d/microsoftrewardspilot-cron.template

# Create the log file to be able to run tail
RUN touch /var/log/cron.log

# Define the command to run your application with cron optionally
CMD ["sh", "-c", "echo \"$TZ\" > /etc/timezone && \
    ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && \
    dpkg-reconfigure -f noninteractive tzdata && \
    envsubst < /etc/cron.d/microsoftrewardspilot-cron.template > /etc/cron.d/microsoftrewardspilot-cron && \
    chmod 0644 /etc/cron.d/microsoftrewardspilot-cron && \
    crontab /etc/cron.d/microsoftrewardspilot-cron && \
    cron -f & \
    ([ \"$RUN_ON_START\" = \"true\" ] && npm start) && \
    tail -f /var/log/cron.log"]