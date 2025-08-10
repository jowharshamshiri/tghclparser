include "root" {
  path = find_in_parent_folders()
}

dependency "global" {
  config_path = "../../global"
}

inputs = {
  global_state = dependency.global.outputs.global_state
  zone         = "planning"
}

