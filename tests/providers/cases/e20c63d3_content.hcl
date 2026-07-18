inputs = {
  log_destination = "arn:aws:s3:::logging-dev-bucket"
  vpc_ids         = ["vpc-011322d88e4677c75", "vpc-062a2daa70a9e5cab"]
  #vpc_ids         = "vpc-062a2daa70a9e5cab"
  enabled = true
  tags = {
    "ucop:application" = local.application
    "ucop:createdBy"   = local.createdBy
    "ucop:environment" = local.environment
    "ucop:group"       = local.group
    "ucop:source"      = local.source
  }
}

locals {
  application = "wheres-my-super-suit"
  createdBy   = "edna.mode@incredibl.es"
  environment = "prod"
  group       = "incredibles"
  source      = "https://github.com/ucopacme/terraform-aws-vpn.git"
}

terraform {
  source = "./.."
}