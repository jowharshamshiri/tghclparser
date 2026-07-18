locals {
  state_bucket = ""
  project      = ""
  location     = "europe-west4"

  # cloud-sql module
  database_version = "POSTGRES_13"

  # compute-engine module
  compute_engine_zone   = "europe-west4-a"
  compute_machine_type  = "e2-micro"
  compute_machine_image = "debian-cloud/debian-9"
}

remote_state {
  backend = "gcs"

  config = {
    bucket   = local.state_bucket
    prefix   = "${path_relative_to_include()}/terraform.tfstate"
    project  = local.project
    location = local.location
  }
}

inputs = {
  project_id = local.project
  location   = local.location

  # cloud-sql module
  database_version = local.database_version

  # compute-engine module
  compute_engine_zone   = local.compute_engine_zone
  compute_machine_type  = local.compute_machine_type
  compute_machine_image = local.compute_machine_image
}