variable "name" {
  type    = string
  default = "obbian-platform"
}
variable "environment" {
  type    = string
  default = "assessment"
}
variable "aws_region" {
  type    = string
  default = "ap-south-1"
}
variable "vpc_cidr" {
  type    = string
  default = "10.42.0.0/16"
}
variable "database_deletion_protection" {
  type    = bool
  default = true
}
variable "eks_version" {
  type        = string
  description = "Choose a currently supported EKS version in the deployment region."
}
variable "database_engine_version" {
  type        = string
  description = "Aurora PostgreSQL version available in the deployment region."
}
variable "operator_cidrs" {
  type        = list(string)
  description = "Operator/runner public CIDRs allowed to reach the EKS control plane."
  validation {
    condition     = length(var.operator_cidrs) > 0 && !contains(var.operator_cidrs, "0.0.0.0/0")
    error_message = "Supply explicit operator CIDRs; a world-open control plane is not allowed."
  }
}
variable "deploy_principal_arn" {
  type        = string
  description = "IAM role/user allowed to deploy Kubernetes resources (never an STS assumed-role ARN)."
}
