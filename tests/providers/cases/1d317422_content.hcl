include "root" {
  path = find_in_parent_folders()
}

dependency "global" {
  config_path = "../../global"
}

dependency "planning_step" {
  config_path = "../planning"
}


dependency "provisioning_step" {
  config_path = "../provisioning"
}

inputs = {
  global_state             = dependency.global.outputs.global_state
  area_file_path           = dependency.planning_step.outputs.area_file_path
  inventory_yaml_file_path = dependency.provisioning_step.outputs.inventory_yaml_file_path
}

