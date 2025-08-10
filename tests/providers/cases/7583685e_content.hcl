include {
  path = find_in_parent_folders()
}

inputs = {
  base_domain = "pablossspot.ga"
  system_name = "wordpress"
  application_port = 80

} 

terraform {
  source = "tfr://app.terraform.io/pablosspot/pablosspot-lb/aws?version=0.0.1"

}

