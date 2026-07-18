remote_state {
  backend = "s3"
  generate = {
    path      = "backend.tf"
    if_exists = "overwrite"
  }
  config = {
    bucket         = "pe-tf-backend"
    key            = "${path_relative_to_include()}/terraform.tfstate"
    region         = "eu-west-2"
    encrypt        = true
    dynamodb_table = "pe-tf-backend"
    s3_bucket_tags = {
      "Project" = "Platform Engineering"
      "User" = "lmilbaum"
    }
    dynamodb_table_tags = {
      "Project" = "Platform Engineering"
      "User" = "lmilbaum"
    }
  }
}