data "aws_iam_policy_document" "webrtc_experiment" {
  statement {
    sid = "UseOnlyExperimentSignalingChannel"

    actions = [
      "kinesisvideo:DescribeSignalingChannel",
      "kinesisvideo:GetSignalingChannelEndpoint",
      "kinesisvideo:GetIceServerConfig",
      "kinesisvideo:ConnectAsMaster",
      "kinesisvideo:ConnectAsViewer",
    ]

    resources = [awscc_kinesisvideo_signaling_channel.experiment.arn]
  }
}

resource "aws_iam_user" "experiment" {
  name = var.iam_user_name
  path = "/experiments/"
}

resource "aws_iam_policy" "webrtc_experiment" {
  name        = "${var.iam_user_name}-channel-access"
  description = "Use only the ${var.channel_name} KVS WebRTC signaling channel."
  policy      = data.aws_iam_policy_document.webrtc_experiment.json
}

resource "aws_iam_user_policy_attachment" "experiment" {
  user       = aws_iam_user.experiment.name
  policy_arn = aws_iam_policy.webrtc_experiment.arn
}

resource "aws_iam_access_key" "experiment" {
  user = aws_iam_user.experiment.name
}

