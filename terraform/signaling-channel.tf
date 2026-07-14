resource "awscc_kinesisvideo_signaling_channel" "experiment" {
  name                = var.channel_name
  type                = "SINGLE_MASTER"
  message_ttl_seconds = 60

  tags = [
    {
      key   = "Project"
      value = "webrtc-aws-turn"
    },
    {
      key   = "ManagedBy"
      value = "Terraform"
    },
    {
      key   = "Purpose"
      value = "local-experiment"
    }
  ]
}

