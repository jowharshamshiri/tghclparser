#include "root" {
#  path = find_in_parent_folders()
#}

dependencies {
  paths = ["modules/s3"]
}

terraform {

  extra_arguments "custom_vars" {
    commands = [
      "apply",
      "plan",
      "import",
      "push",
      "refresh"
    ]

    #    arguments = [
    #      "-var-file=environments/dev/dev.tfvars"
    #    ]

    optional_var_files = [
      "${get_terragrunt_dir()}/environments/${get_env("TF_VAR_env", "dev")}.tfvars"
    ]
  }
}