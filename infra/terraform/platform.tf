data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

resource "aws_eks_access_entry" "deployer" {
  cluster_name  = aws_eks_cluster.main.name
  principal_arn = var.deploy_principal_arn
}
resource "aws_eks_access_policy_association" "deployer" {
  cluster_name  = aws_eks_cluster.main.name
  principal_arn = aws_eks_access_entry.deployer.principal_arn
  policy_arn    = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy"
  access_scope { type = "cluster" }
}

resource "aws_eks_addon" "vpc_cni" {
  cluster_name                = aws_eks_cluster.main.name
  addon_name                  = "vpc-cni"
  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "PRESERVE"
  configuration_values        = jsonencode({ enableNetworkPolicy = "true" })
}
resource "aws_eks_addon" "core" {
  for_each                    = toset(["coredns", "kube-proxy", "eks-pod-identity-agent", "metrics-server"])
  cluster_name                = aws_eks_cluster.main.name
  addon_name                  = each.key
  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "PRESERVE"
  depends_on                  = [aws_eks_node_group.main]
}

locals {
  pod_trust = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "pods.eks.amazonaws.com" }, Action = ["sts:AssumeRole", "sts:TagSession"] }] })
}
resource "aws_iam_role" "pipeline" {
  name               = "${var.name}-${var.environment}-pipeline"
  assume_role_policy = local.pod_trust
}
resource "aws_iam_role_policy" "pipeline" {
  role = aws_iam_role.pipeline.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["kafka-cluster:Connect", "kafka-cluster:DescribeCluster", "kafka-cluster:WriteDataIdempotently"], Resource = aws_msk_serverless_cluster.events.arn },
    { Effect = "Allow", Action = ["kafka-cluster:CreateTopic", "kafka-cluster:DescribeTopic", "kafka-cluster:ReadData", "kafka-cluster:WriteData"], Resource = "${replace(aws_msk_serverless_cluster.events.arn, ":cluster/", ":topic/")}/domain-events*" },
    { Effect = "Allow", Action = ["kafka-cluster:AlterGroup", "kafka-cluster:DescribeGroup"], Resource = "${replace(aws_msk_serverless_cluster.events.arn, ":cluster/", ":group/")}/reporting-v1*" }
  ] })
}
resource "aws_eks_pod_identity_association" "pipeline" {
  cluster_name    = aws_eks_cluster.main.name
  namespace       = "obbian"
  service_account = "pipeline"
  role_arn        = aws_iam_role.pipeline.arn
  depends_on      = [aws_eks_addon.core]
}

resource "aws_iam_role" "observability" {
  name               = "${var.name}-${var.environment}-observability"
  assume_role_policy = local.pod_trust
}
resource "aws_iam_role_policy_attachment" "observability" {
  for_each   = toset(["CloudWatchAgentServerPolicy", "AWSXrayWriteOnlyAccess"])
  role       = aws_iam_role.observability.name
  policy_arn = "arn:aws:iam::aws:policy/${each.key}"
}
resource "aws_eks_pod_identity_association" "observability" {
  cluster_name    = aws_eks_cluster.main.name
  namespace       = "amazon-cloudwatch"
  service_account = "cloudwatch-agent"
  role_arn        = aws_iam_role.observability.arn
  depends_on      = [aws_eks_addon.core]
}
resource "aws_eks_addon" "observability" {
  cluster_name = aws_eks_cluster.main.name
  addon_name   = "amazon-cloudwatch-observability"
  depends_on   = [aws_eks_pod_identity_association.observability, aws_iam_role_policy_attachment.observability]
}

# IRSA for the AWS Load Balancer Controller installed by scripts/bootstrap-aws.sh.
data "tls_certificate" "eks" { url = aws_eks_cluster.main.identity[0].oidc[0].issuer }
resource "aws_iam_openid_connect_provider" "eks" {
  url             = aws_eks_cluster.main.identity[0].oidc[0].issuer
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.eks.certificates[0].sha1_fingerprint]
}
resource "aws_iam_role" "load_balancer" {
  name = "${var.name}-${var.environment}-load-balancer"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect    = "Allow", Action = "sts:AssumeRoleWithWebIdentity",
    Principal = { Federated = aws_iam_openid_connect_provider.eks.arn },
    Condition = { StringEquals = {
      "${replace(aws_iam_openid_connect_provider.eks.url, "https://", "")}:sub" = "system:serviceaccount:kube-system:aws-load-balancer-controller",
      "${replace(aws_iam_openid_connect_provider.eks.url, "https://", "")}:aud" = "sts.amazonaws.com"
    } }
  }] })
}
resource "aws_iam_role_policy" "load_balancer" {
  role   = aws_iam_role.load_balancer.id
  policy = file("${path.module}/load-balancer-policy.json")
}
resource "aws_cloudwatch_metric_alarm" "database_capacity" {
  alarm_name          = "${var.name}-${var.environment}-database-acu"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "ACUUtilization"
  namespace           = "AWS/RDS"
  period              = 60
  statistic           = "Average"
  threshold           = 85
  dimensions          = { DBClusterIdentifier = aws_rds_cluster.postgres.id }
  alarm_description   = "Aurora capacity near its autoscaling limit; inspect query plans and locks."
}
resource "aws_cloudwatch_dashboard" "platform" {
  dashboard_name = "${var.name}-${var.environment}"
  dashboard_body = jsonencode({ widgets = [
    { type = "metric", x = 0, y = 0, width = 12, height = 6, properties = { region = var.aws_region, title = "Database capacity and connections", metrics = [
      ["AWS/RDS", "ACUUtilization", "DBClusterIdentifier", aws_rds_cluster.postgres.id],
      ["AWS/RDS", "DatabaseConnections", "DBClusterIdentifier", aws_rds_cluster.postgres.id]
    ] } },
    { type = "metric", x = 12, y = 0, width = 12, height = 6, properties = { region = var.aws_region, title = "EKS container restarts", metrics = [["ContainerInsights", "pod_number_of_container_restarts", "ClusterName", aws_eks_cluster.main.name, "Namespace", "obbian"]] } }
  ] })
}

# HPA scales pods; this independently adds/removes nodes for pending pods.
resource "aws_autoscaling_group_tag" "autoscaler_enabled" {
  autoscaling_group_name = aws_eks_node_group.main.resources[0].autoscaling_groups[0].name
  tag {
    key                 = "k8s.io/cluster-autoscaler/enabled"
    value               = "true"
    propagate_at_launch = false
  }
}
resource "aws_autoscaling_group_tag" "autoscaler_owned" {
  autoscaling_group_name = aws_eks_node_group.main.resources[0].autoscaling_groups[0].name
  tag {
    key                 = "k8s.io/cluster-autoscaler/${aws_eks_cluster.main.name}"
    value               = "owned"
    propagate_at_launch = false
  }
}
resource "aws_iam_role" "autoscaler" {
  name               = "${var.name}-${var.environment}-autoscaler"
  assume_role_policy = local.pod_trust
}
resource "aws_iam_role_policy" "autoscaler" {
  role = aws_iam_role.autoscaler.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["autoscaling:DescribeAutoScalingGroups", "autoscaling:DescribeAutoScalingInstances", "autoscaling:DescribeLaunchConfigurations", "autoscaling:DescribeScalingActivities", "autoscaling:DescribeTags", "ec2:DescribeImages", "ec2:DescribeInstanceTypes", "ec2:DescribeLaunchTemplateVersions", "ec2:GetInstanceTypesFromInstanceRequirements", "eks:DescribeNodegroup"], Resource = "*" },
    { Effect = "Allow", Action = ["autoscaling:SetDesiredCapacity", "autoscaling:TerminateInstanceInAutoScalingGroup"], Resource = "*", Condition = { StringEquals = {
      "aws:ResourceTag/k8s.io/cluster-autoscaler/enabled"                      = "true",
      "aws:ResourceTag/k8s.io/cluster-autoscaler/${aws_eks_cluster.main.name}" = "owned"
    } } }
  ] })
}
resource "aws_eks_pod_identity_association" "autoscaler" {
  cluster_name    = aws_eks_cluster.main.name
  namespace       = "kube-system"
  service_account = "cluster-autoscaler"
  role_arn        = aws_iam_role.autoscaler.arn
  depends_on      = [aws_eks_addon.core]
}
