locals {
  use_gcs      = true
  state_bucket = "example-terraform-state"

  # Also verifies array literals in ternary branches.
  selected_labels = local.use_gcs ? [
    "remote",
    "gcs",
  ] : [
    "local",
  ]

  # Also verifies nested object literals in ternary branches.
  nested_value = local.use_gcs ? {
    storage = {
      kind   = "gcs"
      bucket = local.state_bucket
    }
  } : {
    storage = {
      kind = "local"
      path = "./terraform.tfstate"
    }
  }
}

remote_state {
  backend = local.use_gcs ? "gcs" : "local"

  # This is the original regression case: both ternary branches are objects.
  config = local.use_gcs ? {
    bucket = local.state_bucket
    prefix = "services/example/dev"
  } : {
    path = "./terraform.tfstate"
  }
}
