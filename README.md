# Discord Chatbot Project
Project for a node.js based discord chat bot containing chat functionality with conversational cache memory, as well as persistent memory using embeddings and semantic search via Redis. Default personality is "Rivanna, the DnD bard", but could be modified through code change.

# Actions
 - /start_chat
	- Starts chat with the chat bot. Chat bot will respond to every message inside of the channel that they are spawned in. Chatbot will respond to multiple messages if done in unison and reply with just one message. Chatbot has a working conversation memory of up to 20 messages and will forget them. Chatbot will have context on the users talking. Will automatically end chat after 15 minutes.
- /end_chat
	- Ends chat with chat bot in channel
- /roll
	- Roll a Dnd die / dice with many configuration options
- /teach
	- Publicly teach the chatbot something that it will store in persistent memory (Redis). Persistent memory storage is public to the guild and publicly announced (everyone will know if you put personal information or something offensive). Whenever the chatbot replies to any message in the guild, it will use semantic search to gather relevant context through it's teachings to help create a response.

# Setup

This bot is confirmed working within an AWS EC2 instance.

Things you'll want to do in AWS:

 - Create secret keys for discord, open-ai, and redis password. (Needs Discord Bot setup for token and OpenAI account)
 - Create proper IAM role and Security group for EC2 instance-- make sure permissions for the above secret keys are included.
 - Start up in EC2 with the following start-up script in the user data field




  
```
#!/bin/bash
sudo yum -y update

# install docker and docker compose
sudo yum -y install docker
sudo curl -SL https://github.com/docker/compose/releases/download/v2.18.1/docker-compose-linux-x86_64 -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose
sudo ln -s /usr/local/bin/docker-compose /usr/bin/docker-compose
sudo service docker start

# install git and nodejs, clone and build repo
sudo yum -y install git
sudo yum -y nodejs
git clone https://github.com/tfonzi/discord_bot_project.git
cd /discord_bot_project
sudo npm install
sudo npm run build

# setup cloudwatch
sudo yum -y install amazon-cloudwatch-agent
sudo touch /opt/aws/amazon-cloudwatch-agent/bin/config.json
sudo echo '{
  "agent": {
    "metrics_collection_interval": 60,
    "run_as_user": "root"
  },
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          {
            "file_path": "/discord_bot_project/botLogs/bot.log",
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
      "AutoScalingGroupName": "${aws:AutoScalingGroupName}",
      "ImageId": "${aws:ImageId}",
      "InstanceId": "${aws:InstanceId}",
      "InstanceType": "${aws:InstanceType}"
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
}' | sudo tee -a /opt/aws/amazon-cloudwatch-agent/bin/config.json
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/bin/config.json

# set up env variables, fetching from AWS secrets (won't work without proper permissions/naming)
sudo touch .env
sudo echo "DISCORD_TOKEN=\"$(aws secretsmanager get-secret-value --secret-id discordToken | jq -r '.SecretString')\"" | sudo tee -a .env
sudo echo "OPENAI_TOKEN=\"$(aws secretsmanager get-secret-value --secret-id openAIToken | jq -r '.SecretString')\"" | sudo tee -a .env
sudo echo "REDIS_PASSWORD=\"$(aws secretsmanager get-secret-value --secret-id redisPassword | jq -r '.SecretString')\"" | sudo tee -a .env

# set up log level
sudo echo 'LOG_LEVEL="DEBUG"' | sudo tee -a .env

# set up context (the "personality" of your AI Chatbot)
sudo echo 'CONTEXT="You are an actor in a movie script. You will respond to all of my questions as Rivanna. Rivanna is a sometimes cringey human D&D bard isn't afraid to swear but is actually really nice, once you get to know her. She lives in the Forgotten Realms. She cares about people but isn’t afraid to joke in a sinister manner. Rivanna has many friends in her party that she goes on adventures with."' | sudo tee -a .env

# retrive redis backup
sudo aws s3 cp s3://rivanna/hourly/embeddings.aof /discord_bot_project/redis-volume/embeddings.aof 

# set up cron
sudo yum -y install cronie

# hourly
(sudo crontab -l 2>/dev/null || true; echo "0 * * * *  /usr/bin/aws s3 cp /discord_bot_project/redis-volume/embeddings.aof s3://rivanna/hourly/embeddings.aof") | sudo crontab -

# daily
(sudo crontab -l 2>/dev/null || true; echo "0 4 * * *  /usr/bin/aws s3 cp /discord_bot_project/redis-volume/embeddings.aof s3://rivanna/daily/embeddings.aof") | sudo crontab -

sudo service crond start

# source env and start chatbot!
source .env
sudo docker-compose up
```