variable "environment" { type = string }
variable "vpc_id" { type = string }
variable "private_subnet_ids" { type = list(string) }
variable "node_type" { type = string }
variable "allowed_security_groups" { type = list(string) }

resource "aws_elasticache_subnet_group" "main" {
  name       = "terminal-${var.environment}"
  subnet_ids = var.private_subnet_ids
}

resource "aws_security_group" "redis" {
  name_prefix = "terminal-redis-"
  vpc_id      = var.vpc_id

  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = var.allowed_security_groups
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "terminal-redis-sg" }
}

resource "aws_elasticache_replication_group" "main" {
  replication_group_id = "terminal-${var.environment}"
  description          = "Financial Terminal Redis cluster"
  node_type            = var.node_type
  num_cache_clusters   = 2
  engine_version       = "7.0"
  port                 = 6379
  subnet_group_name    = aws_elasticache_subnet_group.main.name
  security_group_ids   = [aws_security_group.redis.id]

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  automatic_failover_enabled = true

  snapshot_retention_limit = 7
  snapshot_window          = "04:00-05:00"
  maintenance_window       = "sun:05:00-sun:06:00"

  tags = { Name = "terminal-redis-${var.environment}" }
}

output "endpoint" {
  value = aws_elasticache_replication_group.main.primary_endpoint_address
}

output "connection_url" {
  value     = "rediss://${aws_elasticache_replication_group.main.primary_endpoint_address}:6379"
  sensitive = true
}
