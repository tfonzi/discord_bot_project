resource "aws_security_group" "ec2_sg" {
  name        = "discord-bot-sg"
  description = "Allow SSH from specific IP and all outbound traffic for Discord Bot EC2 instance"

  ingress {
    description = "SSH from My IP"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["${var.my_ip_address}/32"]
  }

  # Ingress rule for SSH removed for security.
  # Consider using AWS Systems Manager Session Manager for shell access if needed.

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1" # Allows all outbound traffic
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "discord-bot-sg"
  }
} 