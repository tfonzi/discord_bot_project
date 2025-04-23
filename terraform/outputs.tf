output "instance_public_ip" {
  description = "Public IP address of the EC2 instance"
  value       = aws_instance.discord_bot.public_ip
}

output "instance_public_dns" {
  description = "Public DNS name of the EC2 instance"
  value       = aws_instance.discord_bot.public_dns
}

output "github_actions_role_arn" {
  description = "ARN of the IAM role for GitHub Actions"
  value       = aws_iam_role.github_actions_role.arn
} 