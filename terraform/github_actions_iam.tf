data "aws_iam_policy_document" "github_oidc_assume_role_policy" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    effect  = "Allow"

    principals {
      type        = "Federated"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:oidc-provider/token.actions.githubusercontent.com"]
    }

    # Condition restricts assuming the role to only the specified GitHub repository
    # You can add further conditions, e.g., restrict to specific branches:
    # condition {
    #   test     = "StringLike"
    #   variable = "token.actions.githubusercontent.com:sub"
    #   values   = ["repo:${var.github_repository}:ref:refs/heads/main"] # Example: only main branch
    # }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:*"]
    }
  }
}

data "aws_iam_policy_document" "terraform_permissions" {
  # Permissions needed by Terraform to manage the defined resources
  statement {
    effect = "Allow"
    actions = [
      # EC2 Permissions
      "ec2:DescribeInstances",
      "ec2:RunInstances",
      "ec2:TerminateInstances",
      "ec2:DescribeImages",
      "ec2:DescribeKeyPairs",
      "ec2:DescribeSecurityGroups",
      "ec2:CreateSecurityGroup",
      "ec2:DeleteSecurityGroup",
      "ec2:AuthorizeSecurityGroupIngress",
      "ec2:RevokeSecurityGroupIngress",
      "ec2:AuthorizeSecurityGroupEgress", # Needed for egress rule management
      "ec2:RevokeSecurityGroupEgress",    # Needed for egress rule management
      "ec2:CreateTags",
      "ec2:DeleteTags",

      # IAM Permissions (Be cautious with IAM permissions)
      "iam:CreateRole",
      "iam:DeleteRole",
      "iam:GetRole",
      "iam:PassRole",
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
      "iam:PutRolePolicy",
      "iam:GetRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:CreateInstanceProfile",
      "iam:DeleteInstanceProfile",
      "iam:GetInstanceProfile",
      "iam:AddRoleToInstanceProfile",
      "iam:RemoveRoleFromInstanceProfile",
      "iam:ListInstanceProfilesForRole",
      "iam:GetPolicy",    # Needed if referencing existing policies
      "iam:CreatePolicy", # Needed if creating new policies
      "iam:DeletePolicy", # Needed if deleting policies

      # SSM Parameter Store Permissions
      "ssm:DescribeParameters",
      "ssm:GetParameters", # Needed to validate EC2 role policy references

      # CloudWatch Logs (For log group creation/management if Terraform handles it - instance needs PutLogEvents)
      "logs:DescribeLogGroups",
      "logs:CreateLogGroup",
      "logs:DeleteLogGroup",

      # S3 (Permissions for state backend, and potentially for the bot's bucket interactions)
      # Adjust as needed if using S3 state backend
      # "s3:ListBucket",
      # "s3:GetObject",
      # "s3:PutObject",
      # "s3:DeleteObject"
      # The role running Terraform generally doesn't need the bot's S3 permissions,
      # but might need permissions if managing the bucket itself or state.

      # General permissions
      "sts:GetCallerIdentity",       # Useful for data sources
      "iam:GetOpenIDConnectProvider" # To read the OIDC provider info
    ]
    resources = ["*"] # Scope down if possible, especially IAM
  }

  # Allow reading the specific secrets referenced by the instance profile policy
  # This ensures plan can validate the policy, but doesn't grant GetSecretValue itself to Terraform runner
  statement {
    effect = "Allow"
    actions = [
      # "secretsmanager:DescribeSecret"
      "ssm:DescribeParameters",
      "ssm:GetParameters"
    ]
    resources = [
      # Updated ARNs for SSM Parameter Store
      "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/${var.discord_parameter_name}",
      "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/${var.openai_parameter_name}",
      "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/${var.redis_parameter_name}"
    ]
  }

  # Allow interacting with the specific S3 bucket for the bot's data
  statement {
    effect = "Allow"
    actions = [
      "s3:ListBucket",
      "s3:GetObject",
      "s3:PutObject"
    ]
    resources = [
      "arn:aws:s3:::${var.s3_bucket_name}",
      "arn:aws:s3:::${var.s3_bucket_name}/*"
    ]
  }

}

resource "aws_iam_role" "github_actions_role" {
  name               = "github-actions-terraform-role"
  assume_role_policy = data.aws_iam_policy_document.github_oidc_assume_role_policy.json
  description        = "IAM role assumed by GitHub Actions to run Terraform"
}

resource "aws_iam_policy" "terraform_policy" {
  name        = "terraform-permissions-policy"
  description = "Policy granting permissions needed by Terraform"
  policy      = data.aws_iam_policy_document.terraform_permissions.json
}

resource "aws_iam_role_policy_attachment" "terraform_attach" {
  role       = aws_iam_role.github_actions_role.name
  policy_arn = aws_iam_policy.terraform_policy.arn
} 