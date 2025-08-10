locals {
  common_vars  = read_terragrunt_config(find_in_parent_folders("common.hcl"))
  account_vars = read_terragrunt_config(find_in_parent_folders("account.hcl"))
  region_vars  = read_terragrunt_config(find_in_parent_folders("region.hcl"))

  aws_region               = local.region_vars.locals.aws_region
  account_id               = local.account_vars.locals.account_id
  tf_state_bucket_name     = local.common_vars.locals.tf_state_bucket_name
  tf_state_key_prefix      = local.common_vars.locals.tf_state_key_prefix
  tf_state_lock_table_name = local.common_vars.locals.tf_state_lock_table_name
}

## Generate an AWS provider block
generate "provider" {
  path      = "provider.tf"
  if_exists = "overwrite_terragrunt"
  contents  = <<PROVIDER
provider "aws" {
  region = "${local.aws_region}"
  allowed_account_ids = ["${local.account_id}"]
}
PROVIDER
}

## Configure Terragrunt to automatically store tfstate files in an S3 bucket.
remote_state {
  backend = "s3"
  config = {
    bucket         = local.tf_state_bucket_name
    key            = "${local.tf_state_key_prefix}/${path_relative_to_include()}/terraform.tfstate"
    region         = local.aws_region
    dynamodb_table = local.tf_state_lock_table_name
    encrypt        = true
  }
  generate = {
    path      = "backend.tf"
    if_exists = "overwrite_terragrunt"
  }
}