variable "environment" { type = string }
variable "vpc_id" { type = string }
variable "private_subnet_ids" { type = list(string) }
variable "instance_class" { type = string }
variable "allowed_security_groups" { type = list(string) }

resource "aws_db_subnet_group" "main" {
  name       = "terminal-${var.environment}"
  subnet_ids = var.private_subnet_ids
  tags       = { Name = "terminal-db-subnet-group" }
}

resource "aws_security_group" "db" {
  name_prefix = "terminal-db-"
  vpc_id      = var.vpc_id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = var.allowed_security_groups
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "terminal-db-sg" }
}

resource "aws_rds_cluster" "main" {
  cluster_identifier     = "terminal-${var.environment}"
  engine                 = "aurora-postgresql"
  engine_version         = "15.4"
  database_name          = "terminal"
  master_username        = "terminal_admin"
  manage_master_user_password = true
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]

  backup_retention_period = 14
  preferred_backup_window = "03:00-04:00"
  deletion_protection     = var.environment == "production"
  skip_final_snapshot     = var.environment != "production"
  final_snapshot_identifier = var.environment == "production" ? "terminal-final-${var.environment}" : null

  serverlessv2_scaling_configuration {
    min_capacity = 0.5
    max_capacity = 16
  }

  tags = { Name = "terminal-aurora-${var.environment}" }
}

resource "aws_rds_cluster_instance" "main" {
  count              = 2
  identifier         = "terminal-${var.environment}-${count.index}"
  cluster_identifier = aws_rds_cluster.main.id
  instance_class     = "db.serverless"
  engine             = aws_rds_cluster.main.engine
  engine_version     = aws_rds_cluster.main.engine_version

  performance_insights_enabled = true
}

output "endpoint" {
  value = aws_rds_cluster.main.endpoint
}

output "connection_url" {
  value     = "postgresql://terminal_admin@${aws_rds_cluster.main.endpoint}:5432/terminal"
  sensitive = true
}
