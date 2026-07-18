locals {

  env                 = yamldecode(file("${get_parent_terragrunt_dir()}/.env.yml"))
  base_terragrunt_dir = get_parent_terragrunt_dir("we")
  current_dir         = get_terragrunt_dir()
  active_env          = local.env.active_env
  base_env_dir        = "${local.base_terragrunt_dir}/envs/${local.active_env}"
  # Handle the case to prevent leading double slashes
  relative_path = replace("${local.current_dir}", "${local.base_terragrunt_dir}", "")

  version = trimspace(file("${get_parent_terragrunt_dir()}/version.txt"))

  # project = {
  #   description = "Abrcity"
  #   sub_project = "${local.relative_path}"
  #   version     = "v${local.version}"
  #   root_dir    = "${get_parent_terragrunt_dir()}"
  #   settings = {
  #     ansible_project_path = "${local.base_terragrunt_dir}/ansible/core"
  #   }
  # }

  project = jsondecode(file("${get_parent_terragrunt_dir()}/project.json"))

  project_config = merge(local.project, {
    version = "v${local.version}"
  })
  # local.project_config.version = "v${local.version}"
}

generate "gen_global_locals" {
  path      = "gen_global_locals.tf"
  if_exists = "overwrite_terragrunt"

  contents = <<EOF

locals {

  base_terragrunt_dir = "${local.base_terragrunt_dir}"

  current_dir = "${local.current_dir}"

  active_env = "${local.active_env}"

  base_env_dir = "${local.base_env_dir}"

   prov_profiles = {
    vms = [
      for profile in var.project.prov_profiles.vms : merge(profile, {
        disk = merge(profile.disk, {
          file_id    = "$${profile.disk.source_disk_image_storage}/$${profile.name}.img",
          image_name = "$${profile.name}.img"
        })
      })
    ],
    containers = [
      for profile in var.project.prov_profiles.containers : merge(profile, {})
    ]
  }
}

EOF
}

generate "gen_zone_locals" {
  path      = "gen_zone_locals.tf"
  if_exists = "overwrite_terragrunt"

  contents = <<EOF

locals {
  # don't know what should go here yet.
}

EOF
}

generate "gen_global_vars" {
  path      = "gen_global_vars.tf"
  if_exists = "overwrite_terragrunt"

  contents = <<EOF

variable "project" {
  description = "Complete project configuration including all subsystems"
  type = object({
    name = string
    description = string
    sub_project = string
    version = string
    root_dir = string
    settings = object({
      ansible_project_path = string
    })
    areas = list(object({
      name = string
      settings = optional(object({
        ansible_extra_args = optional(list(string), [])
      }))
      addons = optional(list(object({
        name   = optional(string)
        playbook_path = string
        priority       = optional(number)
        config = optional(string, "{}")
        tags = optional(list(string), [])
        cluster_uuid = optional(string)
      })), [])
      zones = optional(list(object({
        name                    = string
        prefix                  = string
        settings = optional(object({
          ansible_extra_args = optional(list(string), [])
        }))
        addons = optional(list(object({
          name   = optional(string)
          playbook_path = string
          priority       = optional(number)
          config = optional(string, "{}")
          tags = optional(list(string), [])
          cluster_uuid = optional(string)
        })), [])
        nodes = optional(list(object({
          key                      = string
          tags                     = optional(list(string), [])
          node_type               = string
          pool_id                 = string
          agent = optional(object({
            enabled = bool
          }))
          user_accounts = optional(list(object({
            username = string
            password = optional(string)
            groups   = optional(list(string), [])
          })), [])
          ssh_keys                = optional(list(string), [])
          dns                     = optional(list(string), [])
          mount_points = optional(list(object({
            volume = string
            size   = string
            path   = string
          })), [])
          default_route_ip        = string
          default_route_interface = string
          addons     = optional(list(object({
            name   = optional(string)
            playbook_path = string
            priority       = optional(number)
            config = optional(string, "{}")
            tags = optional(list(string), [])
            cluster_uuid = optional(string)
          })), [])
        })), [])
        groups = optional(list(object({
          group_name = string
          keys       = optional(list(string), [])
          addons     = optional(list(object({
            name   = optional(string)
            playbook_path = string
            priority       = optional(number)
            config = optional(string, "{}")
            tags = optional(list(string), [])
            cluster_uuid = optional(string)
          })), [])
        })), [])
      })), [])
      clusters = list(object({
        uuid = string
        cluster_type = string
        name = optional(string)
        config = optional(string, "{}")
      }))
    }))
    pve_config = object({
      host  = string
      port  = string
      user  = string
      realm = string
      pass  = string
      node_name  = string
      iso_dir = string
      vz_template_dir = string
      snippets_dir = string
      base_vmid = number
      api_timeout = number
      api_tls_verify = bool
      log_level = string
      log_file_path = string
    })
    prov_profiles = object({
      vms = list(object({
        name          = string
        bios          = string
        machine       = string
        description   = string
        tags          = list(string)

        cpu = object({
          cores = number
        })

        memory = object({
          dedicated = number
        })

        disk = object({
          datastore_id = string
          size         = number
          image_name   = string
          file_id      = string
          image_size_gb = number
          source_disk_image_storage = string
        })

        network = object({
          bridge_device = string
        })

        agent = object({
          enabled = bool
        })

        user_account = object({
          group_name = string
          username     = string
          password     = string
          ssh_port     = number
          root_password = string
        })

        initialization = object({
          dns = object({
            domain  = string
            servers = list(string)
          })

          user_account = object({
            keys     = list(string)
            password = string
          })

          preinstalled_apt_packages = optional(list(string))
          open_ports = optional(list(string))
        })

        misc = object({
          readme_text  = optional(string)
          setup_ufw    = optional(bool, false)
          login_banner = optional(string)
        })
      })),
      containers = list(object({
        name           = string
        hostname       = string
        unprivileged   = optional(bool, false)
        description    = string
        tags           = list(string)

        start_on_boot  = optional(bool, true)
        pool_id = string

        cpu = object({
          cores = number
        })

        memory = object({
          dedicated = number
        })


        disk = object({
          datastore_id  = string
          size          = string
        })

        network = object({
          name = string
          mtu  = number
        })

        startup = object({
          order      = string
          up_delay   = string
          down_delay = string
        })


        initialization = object({
          dns = object({
            domain  = string
            servers = list(string)
          })

          user_account = object({
            keys     = list(string)
            password = string
          })

          preinstalled_apt_packages = optional(list(string))
          open_ports = optional(list(string))
        })

        operating_system = object({
          ostemplate  = string
          type    = string
        })


        misc = object({
          readme_text  = optional(string)
          setup_ufw    = optional(bool, false)
          login_banner = optional(string)
        })

        mountpoints = list(object({
          slot        = number
          storage     = string
          mp          = string
          size        = string
        }))
      }))
    })
    qemu_config = object({
      module_active        = bool
      input_image_file                 = string
      input_image_download_url         = string
      output_image_final_copy_path     = string
      force_recreate_images            = bool
      check_images_checksums           = bool
    })
    lxc_config = object({
      module_active        = bool
      input_image_file                 = string
      input_image_download_url         = string
      output_image_final_copy_path     = string
      force_recreate_images            = bool
      check_images_checksums           = bool
    })
    vault_config = object({
      vaults = list(object({
        static_ip = string
        static_ip_subnet = string
        prov_profile_id_tag = string
        key_directory = string
        config_path = string
        data_path = string
        logs_path = string
        tls_disable = string
        ui = string
        domain = string
        port = string
        cluster_port = string
        default_route_ip = string
        default_route_interface = string
        ssh_port = string
        reverse_proxy_config = object({
          reverse_proxies = list(object({
            backend_ssl         = bool
            subdomain           = string
            ip                  = string
            port                = number
            ssl_certificate     = string
            ssl_certificate_key = string
          }))
        })
      }))
      version = string
      ansible_python_interpreter = string
    })
    resolver_config = object({
      dns_config = object({
        zone_ttl = number
        zone_refresh = number
        zone_retry = number
        zone_expire = number
        zone_minimum_ttl = number
        local_domains = list(object({
          domain     = string
          default_ip = string
          cert_path  = string
          key_path   = string
          zone_ttl = optional(number)
          zone_refresh = optional(number)
          zone_retry = optional(number)
          zone_expire = optional(number)
          zone_minimum_ttl = optional(number)
        }))
        subdomains = list(object({
          domain    = string
          ip        = string
          cert_path = string
          key_path  = string
          zone_ttl = optional(number)
          zone_refresh = optional(number)
          zone_retry = optional(number)
          zone_expire = optional(number)
          zone_minimum_ttl = optional(number)
        }))
        arbitrary_domains = list(object({
          domain = string
          ip     = string
        }))
      })
      resolvers = list(object({
        static_ip = string
        static_ip_subnet = string
        prov_profile_id_tag = string
        dns_port = string
        key_directory = string
        dhcp_range_start     = string
        dhcp_range_end       = string
        dhcp_subnet_mask     = string
        dhcp_lease_time      = string
        dhcp_router = string
        default_route_ip = string
        default_route_interface = string
        ssh_port = string
        reverse_proxy_config = object({
          reverse_proxies = list(object({
            backend_ssl         = bool
            subdomain           = string
            ip                  = string
            port                = number
            ssl_certificate     = string
            ssl_certificate_key = string
          }))
        })
      }))
      root_hints_url = string
      ansible_python_interpreter = string
    })
  })

  validation {
    condition     = length(var.project.vault_config.vaults) > 0
    error_message = "At least one Vault instance must be configured."
  }

  validation {
    condition     = length(var.project.resolver_config.resolvers) > 0
    error_message = "At least one resolver must be configured."
  }
}

EOF
}

generate "gen_zone_vars" {
	
  path      = "gen_zone_vars.tf"
  if_exists = "overwrite_terragrunt"
  disable   = startswith(local.relative_path, "/envs/${local.active_env}/steps") ? false : true

  contents = <<EOF
variable "module_active" {
  description = "Enable or disable the module"
  type        = bool
  default     = true
}

EOF
}

generate "gen_global_tfvars" {
  path      = "gen_global.auto.tfvars"
  if_exists = "overwrite_terragrunt"

  contents = <<EOF
project = ${jsonencode(local.project_config)}
EOF
}

generate "gen_zone_tfvars" {
  path      = "gen_zone.auto.tfvars"
  if_exists = "overwrite_terragrunt"
  disable   = startswith(local.relative_path, "/envs/${local.active_env}/steps") ? false : true

  contents = <<EOF
  #don't know what should go here yet.
EOF
}

generate "gen_control_zone_tfvars" {
  path      = "gen_cz.auto.tfvars"
  if_exists = "overwrite_terragrunt"
  disable   = startswith(local.relative_path, "/envs/${local.active_env}/steps") ? false : true

  contents = <<EOF

EOF
}

# generate "gen_service_zone_tfvars" {
#   path      = "gen_sz.auto.tfvars"
#   if_exists = "overwrite_terragrunt"
#   disable   = local.relative_path == "/envs/${local.active_env}/steps/planning" ? false : true

#   contents = <<EOF

# zone_plan = ${jsonencode(local.service_zone_plan)}
# EOF
# }

generate "gen_deploy_zone_locals" {
  path      = "gen_dz_locals.tf"
  if_exists = "overwrite_terragrunt"
  disable   = startswith(local.relative_path, "/envs/${local.active_env}/steps") ? false : true

  contents = <<EOF

locals {
  kube_config = {
    module_active        = true
    login_banner         = "Welcome to the Kubernetes cluster"
  }
}
EOF
}

# generate "gen_deploy_zone_tfvars" {
#   path      = "gen_dz.auto.tfvars"
#   if_exists = "overwrite_terragrunt"
#   disable   = local.relative_path == "/envs/${local.active_env}/steps/planning" ? false : true
#   contents  = <<EOF

# zone_plan = ${jsonencode(local.deploy_zone_plan)}

# EOF
# }
