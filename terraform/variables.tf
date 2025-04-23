variable "aws_region" {
  description = "AWS region to deploy resources"
  type        = string
  default     = "us-east-1" # Change if needed
}

variable "instance_type" {
  description = "EC2 instance type"
  type        = string
  default     = "t2.micro" # Choose an appropriate instance type
}

variable "key_name" {
  description = "Name of the EC2 key pair for SSH access (required for SSH ingress rule)"
  type        = string
  # No default - user must provide their key pair name
}

variable "my_ip_address" {
  description = "Your public IP address allowed for SSH access."
  type        = string
  default     = "72.238.76.109" # Use the provided IP as default
}

variable "discord_parameter_name" {
  description = "Name of the AWS Systems Manager Parameter Store parameter for the Discord token (SecureString recommended)"
  type        = string
  default     = "discordTokenParam" # Example name
}

variable "openai_parameter_name" {
  description = "Name of the AWS Systems Manager Parameter Store parameter for the OpenAI token (SecureString recommended)"
  type        = string
  default     = "openAITokenParam" # Example name
}

variable "redis_parameter_name" {
  description = "Name of the AWS Systems Manager Parameter Store parameter for the Redis password (SecureString recommended)"
  type        = string
  default     = "redisPasswordParam" # Example name
}

variable "s3_bucket_name" {
  description = "Name of the S3 bucket for Redis backups"
  type        = string
  default     = "discord-bot-2025" # Replace with your actual bucket name
}

variable "log_level" {
  description = "Log level for the bot (e.g., DEBUG, INFO, WARN)"
  type        = string
  default     = "DEBUG"
}

variable "ami_owner" {
  description = "Owner ID for the AMI search (e.g., 'amazon' for official Amazon Linux AMIs)"
  type        = string
  default     = "amazon"
}

variable "ami_name_filter" {
  description = "Filter for AMI name search (e.g., 'amzn2-ami-hvm-*-x86_64-gp2')"
  type        = string
  default     = "amzn2-ami-hvm-*-x86_64-gp2"
}

variable "github_repository" {
  description = "GitHub repository in 'owner/repo' format, used for OIDC trust policy."
  type        = string
  # No default - user must provide their repository name
} 