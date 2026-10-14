output "eks_cluster_name" { value = aws_eks_cluster.main.name }
output "database_endpoint" {
  value     = aws_rds_cluster.postgres.endpoint
  sensitive = true
}
output "redis_endpoint" {
  value     = aws_elasticache_replication_group.redis.primary_endpoint_address
  sensitive = true
}
output "kafka_bootstrap_brokers" {
  value     = aws_msk_serverless_cluster.events.bootstrap_brokers_sasl_iam
  sensitive = true
}
output "ecr_repositories" { value = { for name, repository in aws_ecr_repository.services : name => repository.repository_url } }
output "vpc_id" { value = aws_vpc.main.id }
output "application_secret_arn" { value = aws_secretsmanager_secret.application.arn }
output "database_master_secret_arn" {
  value     = aws_rds_cluster.postgres.master_user_secret[0].secret_arn
  sensitive = true
}
output "load_balancer_controller_role_arn" { value = aws_iam_role.load_balancer.arn }
