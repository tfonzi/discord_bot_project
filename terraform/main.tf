terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project = "discord-bot-2025"
    }
  }
}

# Find the latest Amazon Linux 2 AMI
data "aws_ami" "amazon_linux_2" {
  most_recent = true
  owners      = [var.ami_owner]

  filter {
    name   = "name"
    values = [var.ami_name_filter]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# EC2 Instance
resource "aws_instance" "discord_bot" {
  ami                    = data.aws_ami.amazon_linux_2.id
  instance_type          = var.instance_type
  key_name               = var.key_name
  iam_instance_profile   = aws_iam_instance_profile.ec2_profile.name
  vpc_security_group_ids = [aws_security_group.ec2_sg.id]

  # Render the user data script, substituting variables
  user_data = templatefile("${path.module}/user_data.sh", {
    discord_parameter_name = var.discord_parameter_name
    openai_parameter_name  = var.openai_parameter_name
    redis_parameter_name   = var.redis_parameter_name
    s3_bucket_name         = var.s3_bucket_name
    log_level              = var.log_level
  })

  tags = {
    Name = "discord-bot-instance"
  }

  # If creation fails, taint the resource so it gets recreated on next apply
  #lifecycle {
  #  create_before_destroy = true # Consider if needed based on your update strategy
  #}
} 