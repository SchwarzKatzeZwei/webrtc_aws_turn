variable "aws_region" {
  description = "AWS region in which to create the signaling channel."
  type        = string
  default     = "ap-northeast-1"
}

variable "channel_name" {
  description = "Kinesis Video Streams signaling channel name."
  type        = string
  default     = "laptop-webrtc-sample"
}

variable "iam_user_name" {
  description = "Name of the IAM user used only by the local experiment."
  type        = string
  default     = "laptop-webrtc-sample-user"
}

