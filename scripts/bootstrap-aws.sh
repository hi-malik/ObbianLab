#!/usr/bin/env bash
set -euo pipefail
: "${CLUSTER_NAME:?Set CLUSTER_NAME}"
: "${AWS_REGION:?Set AWS_REGION}"
: "${VPC_ID:?Set VPC_ID from Terraform output}"
: "${LOAD_BALANCER_ROLE_ARN:?Set LOAD_BALANCER_ROLE_ARN from Terraform output}"
aws eks update-kubeconfig --name "$CLUSTER_NAME" --region "$AWS_REGION"
helm repo add eks https://aws.github.io/eks-charts
helm repo update eks
helm upgrade --install aws-load-balancer-controller eks/aws-load-balancer-controller \
  --version 1.13.3 --namespace kube-system \
  --set clusterName="$CLUSTER_NAME" --set region="$AWS_REGION" --set vpcId="$VPC_ID" \
  --set serviceAccount.create=true --set serviceAccount.name=aws-load-balancer-controller \
  --set "serviceAccount.annotations.eks\\.amazonaws\\.com/role-arn=$LOAD_BALANCER_ROLE_ARN" \
  --wait --timeout 5m
# The autoscaler image's Kubernetes minor must match the EKS control plane.
: "${AUTOSCALER_CHART_VERSION:?Pin a supported autoscaler chart version}"
: "${AUTOSCALER_IMAGE_TAG:?Pin autoscaler image matching the EKS Kubernetes minor}"
helm repo add autoscaler https://kubernetes.github.io/autoscaler
helm repo update autoscaler
helm upgrade --install cluster-autoscaler autoscaler/cluster-autoscaler \
  --version "$AUTOSCALER_CHART_VERSION" --namespace kube-system \
  --set autoDiscovery.clusterName="$CLUSTER_NAME" --set awsRegion="$AWS_REGION" \
  --set image.tag="$AUTOSCALER_IMAGE_TAG" --set rbac.serviceAccount.name=cluster-autoscaler \
  --set extraArgs.balance-similar-node-groups=true --set extraArgs.skip-nodes-with-system-pods=false \
  --wait --timeout 5m
