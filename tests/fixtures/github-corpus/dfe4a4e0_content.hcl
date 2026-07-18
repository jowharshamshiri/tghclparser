# Provide Terraform backend and provider configuration depending on the `IAC_ENV` environment variable

generate "backend" {
  path      = "backend.tf"
  if_exists = "overwrite_terragrunt"
  contents = file("environments/${get_env("IAC_ENV")}/backend.tf")
}

generate "provider" {
  path = "provider.tf"
  if_exists = "overwrite_terragrunt"
  contents = file("environments/${get_env("IAC_ENV")}/provider.tf")
}

generate "locals" {
  path = "locals.tf"
  if_exists = "overwrite_terragrunt"
  contents = file("environments/${get_env("IAC_ENV")}/locals.tf")
}