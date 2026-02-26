###############################################################################
# Financial Market Terminal — AWS Infrastructure
#
# Architecture:
#   ECS Fargate for stateless services (API, frontend, data-ingestion, analytics)
#   RDS PostgreSQL with TimescaleDB AMI for relational + time-series
#   ElastiCache Redis for caching and streaming
#   ALB for load balancing with TLS termination
#   CloudWatch + Prometheus for monitoring
###############################################################################

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.30"
    }
  }

  backend "s3" {
    bucket         = "terminal-terraform-state"
    key            = "infrastructure/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "terminal-terraform-locks"
    encrypt        = true
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "financial-terminal"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

# ─────────────────────────────────────────────
# Variables
# ─────────────────────────────────────────────
variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "environment" {
  type    = string
  default = "production"
}

variable "vpc_cidr" {
  type    = string
  default = "10.0.0.0/16"
}

variable "db_instance_class" {
  type    = string
  default = "db.r6g.xlarge"
}

variable "redis_node_type" {
  type    = string
  default = "cache.r6g.large"
}

variable "api_desired_count" {
  type    = number
  default = 2
}

variable "domain_name" {
  type    = string
  default = ""
}

# ─────────────────────────────────────────────
# VPC
# ─────────────────────────────────────────────
module "vpc" {
  source = "./modules/vpc"

  vpc_cidr     = var.vpc_cidr
  environment  = var.environment
  aws_region   = var.aws_region
}

# ─────────────────────────────────────────────
# RDS (PostgreSQL + TimescaleDB)
# ─────────────────────────────────────────────
module "database" {
  source = "./modules/database"

  environment       = var.environment
  vpc_id            = module.vpc.vpc_id
  private_subnet_ids = module.vpc.private_subnet_ids
  instance_class    = var.db_instance_class
  allowed_security_groups = [module.ecs.service_security_group_id]
}

# ─────────────────────────────────────────────
# ElastiCache (Redis)
# ─────────────────────────────────────────────
module "redis" {
  source = "./modules/redis"

  environment        = var.environment
  vpc_id             = module.vpc.vpc_id
  private_subnet_ids = module.vpc.private_subnet_ids
  node_type          = var.redis_node_type
  allowed_security_groups = [module.ecs.service_security_group_id]
}

# ─────────────────────────────────────────────
# ECS Cluster + Services
# ─────────────────────────────────────────────
module "ecs" {
  source = "./modules/ecs"

  environment        = var.environment
  vpc_id             = module.vpc.vpc_id
  private_subnet_ids = module.vpc.private_subnet_ids
  public_subnet_ids  = module.vpc.public_subnet_ids
  database_url       = module.database.connection_url
  redis_url          = module.redis.connection_url
  api_desired_count  = var.api_desired_count
  domain_name        = var.domain_name
}

# ─────────────────────────────────────────────
# Outputs
# ─────────────────────────────────────────────
output "api_endpoint" {
  value       = module.ecs.api_endpoint
  description = "API load balancer endpoint"
}

output "frontend_endpoint" {
  value       = module.ecs.frontend_endpoint
  description = "Frontend URL"
}

output "database_endpoint" {
  value       = module.database.endpoint
  description = "Database endpoint (private)"
  sensitive   = true
}

output "redis_endpoint" {
  value       = module.redis.endpoint
  description = "Redis endpoint (private)"
  sensitive   = true
}
