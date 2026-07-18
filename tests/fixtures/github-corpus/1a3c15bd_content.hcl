include "root" {
  path = find_in_parent_folders()
}

dependency "global" {
  config_path = "../../global"
}

dependency "planning_step" {
  config_path = "../planning"
}

inputs = {
  global_state   = dependency.global.outputs.global_state
  area_file_path = dependency.planning_step.outputs.area_file_path
}

