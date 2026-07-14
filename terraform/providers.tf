provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project   = "webrtc-aws-turn"
      ManagedBy = "Terraform"
      Purpose   = "local-experiment"
    }
  }
}

provider "awscc" {
  region = var.aws_region
}

