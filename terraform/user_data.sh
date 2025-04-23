#!/bin/bash
sleep 10 # Add a small delay to ensure network/services are ready
yum -y update

# install docker and docker compose
yum -y install docker
curl -SL https://github.com/docker/compose/releases/download/v2.18.1/docker-compose-linux-x86_64 -o /usr/local/bin/docker-compose
chmod +x /usr/local/bin/docker-compose
ln -s /usr/local/bin/docker-compose /usr/bin/docker-compose
service docker start
usermod -a -G docker ec2-user # Add ec2-user to docker group

sudo systemctl start docker
sudo systemctl enable docker
sudo systemctl status docker

# install git, clone repo
yum -y install git
# Node.js will be installed using NVM below by the ec2-user

git clone https://github.com/tfonzi/discord_bot_project.git /home/ec2-user/discord_bot_project
chown -R ec2-user:ec2-user /home/ec2-user/discord_bot_project

# Switch to ec2-user to install NVM, Node.js, dependencies and build
sudo -u ec2-user -i <<'EOF'
cd /home/ec2-user/discord_bot_project
git checkout v2 # Ensure this branch/tag exists

# Install NVM
echo "Installing NVM..."
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
# Source NVM script to make nvm command available in this subshell
export NVM_DIR="/home/ec2-user/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Install and use Node.js 16
echo "Installing Node.js 16..."
nvm install 16
nvm use 16
nvm alias default 16 # Set default node version for future sessions

echo "Node version:"
node -v
echo "NPM version:"
npm -v

# Install dependencies and build
echo "Running npm install..."
npm install
echo "Running npm run build..."
npm run build
EOF

# setup cloudwatch
yum -y install amazon-cloudwatch-agent
touch /opt/aws/amazon-cloudwatch-agent/bin/config.json
echo '{
  "agent": {
    "metrics_collection_interval": 60,
    "run_as_user": "root"
  },
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          {
            "file_path": "/home/ec2-user/discord_bot_project/logs/bot.log",
            "log_group_name": "bot.log",
            "log_stream_name": "{instance_id}",
            "retention_in_days": 7
          }
        ]
      }
    }
  },
  "metrics": {
    "aggregation_dimensions": [
      [
        "InstanceId"
      ]
    ],
    "append_dimensions": {
      "AutoScalingGroupName": "$${aws:AutoScalingGroupName}",
      "ImageId": "$${aws:ImageId}",
      "InstanceId": "$${aws:InstanceId}",
      "InstanceType": "$${aws:InstanceType}"
    },
    "metrics_collected": {
      "disk": {
        "measurement": [
          "used_percent"
        ],
        "metrics_collection_interval": 60,
        "resources": [
          "*"
        ]
      },
      "mem": {
        "measurement": [
          "mem_used_percent"
        ],
        "metrics_collection_interval": 60
      }
    }
  }
}' > /opt/aws/amazon-cloudwatch-agent/bin/config.json
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/bin/config.json

# set up env variables, fetching from AWS Parameter Store
cd /home/ec2-user/discord_bot_project
touch .env
# Note: These commands need the AWS CLI and jq installed, and the EC2 instance profile must have permissions
yum -y install jq aws-cli

REGION=$(curl -s http://169.254.169.254/latest/meta-data/placement/region)

# Fetch all parameters at once
PARAM_JSON=$(aws ssm get-parameters --names "${discord_parameter_name}" "${openai_parameter_name}" "${redis_parameter_name}" --with-decryption --region $REGION --output json)

# Check if the command was successful and Parameters exist
if [ $? -eq 0 ] && [ "$(echo $PARAM_JSON | jq '.Parameters | length')" -gt 0 ]; then
  DISCORD_TOKEN=$(echo $PARAM_JSON | jq -r --arg name "${discord_parameter_name}" '.Parameters[] | select(.Name==$name) | .Value')
  OPENAI_TOKEN=$(echo $PARAM_JSON | jq -r --arg name "${openai_parameter_name}" '.Parameters[] | select(.Name==$name) | .Value')
  REDIS_PASSWORD=$(echo $PARAM_JSON | jq -r --arg name "${redis_parameter_name}" '.Parameters[] | select(.Name==$name) | .Value')

  # Write to .env file if values were found
  [ -n "$DISCORD_TOKEN" ] && echo "DISCORD_TOKEN=\"$DISCORD_TOKEN\"" >> .env
  [ -n "$OPENAI_TOKEN" ] && echo "OPENAI_TOKEN=\"$OPENAI_TOKEN\"" >> .env
  [ -n "$REDIS_PASSWORD" ] && echo "REDIS_PASSWORD=\"$REDIS_PASSWORD\"" >> .env
else
  echo "Error fetching parameters from SSM Parameter Store or parameters not found." >> /home/ec2-user/discord_bot_project/logs/startup_error.log
  # Optionally, exit the script if parameters are critical
  # exit 1
fi

# set up log level
echo "LOG_LEVEL=\"${log_level}\"" >> .env

# set up context (the "personality" of your AI Chatbot)
echo 'CONTEXT="You are an actor in a movie script. You will respond to all of my questions as Rivanna. Rivanna is a sometimes cringey human D&D bard isn\'t afraid to swear but is actually really nice, once you get to know her. She lives in the Forgotten Realms. She cares about people but isn't afraid to joke in a sinister manner. Rivanna has many friends in her party that she goes on adventures with."' >> .env

# Ensure redis-volume exists and has correct permissions before S3 copy
mkdir -p /home/ec2-user/discord_bot_project/redis-volume
chown ec2-user:ec2-user /home/ec2-user/discord_bot_project/redis-volume

# retrieve redis backup if it exists
aws s3 cp s3://${s3_bucket_name}/hourly/embeddings.aof /home/ec2-user/discord_bot_project/redis-volume/embeddings.aof --region $REGION || echo "Failed to retrieve hourly backup, continuing..."
chown ec2-user:ec2-user /home/ec2-user/discord_bot_project/redis-volume/embeddings.aof

# set up cron
yum -y install cronie

CRON_CMD_HOURLY="0 * * * *  /usr/bin/aws s3 cp /home/ec2-user/discord_bot_project/redis-volume/embeddings.aof s3://${s3_bucket_name}/hourly/embeddings.aof --region $REGION"
CRON_CMD_DAILY="0 4 * * *  /usr/bin/aws s3 cp /home/ec2-user/discord_bot_project/redis-volume/embeddings.aof s3://${s3_bucket_name}/daily/embeddings.aof --region $REGION"

# Add cron jobs for ec2-user
(crontab -u ec2-user -l 2>/dev/null || true; echo "$CRON_CMD_HOURLY") | crontab -u ec2-user -
(crontab -u ec2-user -l 2>/dev/null || true; echo "$CRON_CMD_DAILY") | crontab -u ec2-user -

service crond start

# Set ownership for the entire project dir again before starting
chown -R ec2-user:ec2-user /home/ec2-user/discord_bot_project

# Change to project directory and start chatbot as ec2-user
cd /home/ec2-user/discord_bot_project

sudo -u ec2-user -E bash -c '
source .env
docker-compose up -d # Run in detached mode
' 