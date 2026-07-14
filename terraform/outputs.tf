output "aws_region" {
  description = "AWS region used by the web application."
  value       = var.aws_region
}

output "signaling_channel_name" {
  description = "KVS signaling channel name."
  value       = awscc_kinesisvideo_signaling_channel.experiment.name
}

output "signaling_channel_arn" {
  description = "KVS signaling channel ARN."
  value       = awscc_kinesisvideo_signaling_channel.experiment.arn
}

output "aws_access_key_id" {
  description = "Access key ID for the experiment IAM user."
  value       = aws_iam_access_key.experiment.id
}

output "aws_secret_access_key" {
  description = "Secret access key for the experiment IAM user."
  value       = aws_iam_access_key.experiment.secret
  sensitive   = true
}

