"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const ec2 = require("aws-cdk-lib/aws-ec2");
const ecs = require("aws-cdk-lib/aws-ecs");
const cdk = require("aws-cdk-lib");
const aws_logs_1 = require("aws-cdk-lib/aws-logs");
const aws_ecs_1 = require("aws-cdk-lib/aws-ecs");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const aws_elasticloadbalancingv2_1 = require("aws-cdk-lib/aws-elasticloadbalancingv2");
const fargate_spot_fallback_1 = require("@wheatstalk/fargate-spot-fallback");
const aws_ecr_1 = require("aws-cdk-lib/aws-ecr");
const aws_iam_1 = require("aws-cdk-lib/aws-iam");
class R7qAdvancedServerlessMicroserviceStack extends cdk.Stack {
    constructor(scope, id, props) {
        if (!props.isX86) {
            props.useSpot = false;
        }
        super(scope, id, props);
        let vpc = undefined;
        if (props.vpcName !== undefined) {
            vpc = ec2.Vpc.fromLookup(this, props.vpcName, {
                isDefault: false,
            });
        }
        else {
            vpc = new ec2.Vpc(this, 'MyVpc', { maxAzs: 2 });
        }
        let taskRole = undefined;
        if (props.executionRoleName !== undefined) {
            taskRole = aws_iam_1.Role.fromRoleName(this, `${props.serviceName}-executionRole`, props.executionRoleName);
            taskRole.addManagedPolicy(aws_iam_1.ManagedPolicy.fromAwsManagedPolicyName("AWSXRayDaemonWriteAccess"));
        }
        else {
            taskRole = new aws_iam_1.Role(this, `${props.serviceName}-executionRole`, {
                assumedBy: new aws_iam_1.ServicePrincipal("ecs-tasks.amazonaws.com")
            });
            taskRole.addManagedPolicy(aws_iam_1.ManagedPolicy.fromAwsManagedPolicyName("AWSXRayDaemonWriteAccess"));
            const permissions = new aws_iam_1.PolicyStatement({
                actions: [
                    'ssmmessages:*',
                    'dynamodb:*',
                    'rds:*',
                    'cloudwatch:*',
                ],
                resources: [
                    `*`
                ],
            });
            let policy = new aws_iam_1.Policy(this, `${props.serviceName}-ExecutionRolePolicy`, {
                statements: [
                    permissions
                ]
            });
            taskRole.addManagedPolicy(aws_iam_1.ManagedPolicy.fromAwsManagedPolicyName("AmazonDynamoDBFullAccess"));
            taskRole.attachInlinePolicy(policy);
        }
        const cluster = new ecs.Cluster(this, `${props.serviceName}-FargateCluster`, {
            vpc,
            clusterName: `${props.serviceName}-FargateCluster`,
            enableFargateCapacityProviders: true,
            containerInsights: true
        });
        const logGroupApplication = new aws_logs_1.LogGroup(this, `${props.serviceName}-application-logs`, {
            retention: aws_logs_1.RetentionDays.SIX_MONTHS,
        });
        const logGroupXray = new aws_logs_1.LogGroup(this, `${props.serviceName}-x-ray-logs`, {
            retention: aws_logs_1.RetentionDays.SIX_MONTHS,
        });
        // create a task definition with CloudWatch Logs
        const logging = new ecs.AwsLogDriver({
            streamPrefix: `${props.serviceName}`,
            logGroup: logGroupApplication,
            maxBufferSize: aws_cdk_lib_1.Size.mebibytes(3),
            mode: aws_ecs_1.AwsLogDriverMode.NON_BLOCKING
        });
        const xrayLogging = new ecs.AwsLogDriver({
            streamPrefix: `${props.serviceName}`,
            logGroup: logGroupXray,
            maxBufferSize: aws_cdk_lib_1.Size.mebibytes(3),
            mode: aws_ecs_1.AwsLogDriverMode.NON_BLOCKING
        });
        const taskDef = new ecs.FargateTaskDefinition(this, `${props.serviceName}-TaskDefinition`, {
            memoryLimitMiB: props.memoryPerServer,
            cpu: props.cpuPerServer,
            executionRole: taskRole,
            taskRole: taskRole,
            runtimePlatform: {
                operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
                cpuArchitecture: props.isX86 ? ecs.CpuArchitecture.X86_64 : ecs.CpuArchitecture.ARM64
            }
        });
        taskDef.addContainer('xray', {
            image: ecs.ContainerImage.fromRegistry('amazon/aws-xray-daemon'),
            portMappings: [
                {
                    "containerPort": 2000,
                    "protocol": aws_ecs_1.Protocol.UDP
                }
            ],
            cpu: 32,
            memoryReservationMiB: 128,
            essential: false,
            logging: xrayLogging
        });
        // let healthCheckUrl = `http://localhost:${props.port}${props.healthCheckPath}`;
        let healthCheckUrl = `http://localhost/`;
        taskDef.addContainer(`${props.serviceName}-application`, {
            image: ecs.ContainerImage.fromEcrRepository(aws_ecr_1.Repository.fromRepositoryArn(this, `${props.serviceName}-repository`, props.ecrRepo), props.tag),
            containerName: `${props.serviceName}-application`,
            logging: logging,
            essential: true,
            environment: {
                ...props.enviromentVariables
            },
            portMappings: [
                {
                    "containerPort": props.port,
                    "protocol": aws_ecs_1.Protocol.TCP
                }
            ],
            healthCheck: {
                command: ["CMD-SHELL", `curl -f ${healthCheckUrl} || exit 1`]
            }
        });
        const lb = new aws_elasticloadbalancingv2_1.ApplicationLoadBalancer(this, `${props.serviceName}-Alb`, {
            vpc,
            loadBalancerName: `${props.serviceName}`,
            internetFacing: props.internetFacing,
        });
        lb.setAttribute('routing.http.desync_mitigation_mode', 'strictest');
        lb.setAttribute('routing.http.drop_invalid_header_fields.enabled', 'true');
        lb.setAttribute('routing.http.preserve_host_header.enabled', 'true');
        let listener = lb.addListener(`${props.serviceName}-listener`, {
            protocol: aws_elasticloadbalancingv2_1.ApplicationProtocol.HTTP,
            port: 80
        });
        let security = new ec2.SecurityGroup(this, `${props.serviceName}-security-group`, {
            description: `Security group that defines port ingress/egress for the ${props.serviceName} backend`,
            vpc: vpc,
            allowAllOutbound: true,
            allowAllIpv6Outbound: true
        });
        security.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(props.port));
        security.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.icmpPing());
        let securityGroups = [security];
        // Create a fallback service with on-demand Fargate and a desired count of
        // zero. This service should be the same as your primary service, except
        // with a different capacity provider and an initial desired count of zero.
        let fargateService = new ecs.FargateService(this, `${props.serviceName}-FargateService`, {
            cluster,
            taskDefinition: taskDef,
            platformVersion: ecs.FargatePlatformVersion.VERSION1_4,
            capacityProviderStrategies: [{ capacityProvider: 'FARGATE', weight: 1 }],
        });
        const scalableTarget = fargateService.autoScaleTaskCount({
            minCapacity: 1,
            maxCapacity: 3,
        });
        scalableTarget.scaleOnCpuUtilization(`${props.serviceName}-CpuScaling`, {
            targetUtilizationPercent: 90,
        });
        scalableTarget.scaleOnMemoryUtilization(`${props.serviceName}-MemoryScaling`, {
            targetUtilizationPercent: 90,
        });
        if (props.useSpot && props.isX86) {
            let fgSpotService = new ecs.FargateService(this, `${props.serviceName}-FargateSpotService`, {
                cluster,
                taskDefinition: taskDef,
                securityGroups: securityGroups,
                platformVersion: ecs.FargatePlatformVersion.VERSION1_4,
                capacityProviderStrategies: [{ capacityProvider: 'FARGATE_SPOT', weight: 1 }],
                desiredCount: 1,
            });
            listener.addTargets(`${props.serviceName}-FargateTarget`, {
                port: props.port,
                targets: [fgSpotService.loadBalancerTarget({
                        containerName: `${props.serviceName}-application`,
                        containerPort: props.port,
                    }), fargateService.loadBalancerTarget({
                        containerName: `${props.serviceName}-application`,
                        containerPort: props.port,
                    })]
            });
            // Create the fallback policy which increases the fallback service's desired
            // count when the primary service can't provision tasks.
            new fargate_spot_fallback_1.FallbackPolicy(this, `${props.serviceName}-FallbackPolicy-Do-not-delete`, {
                primaryService: fargateService,
                fallbackService: fgSpotService,
            });
        }
        else {
            listener.addTargets(`${props.serviceName}-FargateTarget`, {
                port: props.port,
                targets: [fargateService.loadBalancerTarget({
                        containerName: `${props.serviceName}-application`,
                        containerPort: props.port,
                    })]
            });
        }
    }
}
const app = new cdk.App();
let serviceName = "r7q";
new R7qAdvancedServerlessMicroserviceStack(app, `R7qAdvancedServerlessMicroserviceStack-${serviceName}`, {
    serviceName: serviceName,
    ecrRepo: "arn:aws:ecr:us-east-1:154701738773:repository/novacloud-repository",
    tag: "latest",
    memoryPerServer: 1024,
    cpuPerServer: 512,
    desiredCount: 1,
    isX86: false,
    internetFacing: true,
    useSpot: false,
    healthCheckPath: "/",
    enviromentVariables: {
        "DATABASE_NAME": `dynamodbtimeseries`,
    },
    port: 80
});
app.synth();
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJpbmRleC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOztBQUFBLDJDQUE0QztBQUM1QywyQ0FBNEM7QUFDNUMsbUNBQW9DO0FBQ3BDLG1EQUErRDtBQUMvRCxpREFBaUU7QUFDakUsNkNBQStDO0FBQy9DLHVGQUFzRztBQUN0Ryw2RUFBbUU7QUFDbkUsaURBQWlEO0FBQ2pELGlEQUFxRztBQXNCckcsTUFBTSxzQ0FBdUMsU0FBUSxHQUFHLENBQUMsS0FBSztJQUM1RCxZQUFZLEtBQWMsRUFBRSxFQUFVLEVBQUUsS0FBa0Q7UUFDeEYsSUFBRyxDQUFDLEtBQUssQ0FBQyxLQUFLLEVBQUM7WUFDZCxLQUFLLENBQUMsT0FBTyxHQUFHLEtBQUssQ0FBQztTQUN2QjtRQUVELEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBQ3hCLElBQUksR0FBRyxHQUFHLFNBQVMsQ0FBQztRQUNwQixJQUFJLEtBQUssQ0FBQyxPQUFPLEtBQUssU0FBUyxFQUFDO1lBQzlCLEdBQUcsR0FBRyxHQUFHLENBQUMsR0FBRyxDQUFDLFVBQVUsQ0FBQyxJQUFJLEVBQUUsS0FBSyxDQUFDLE9BQU8sRUFBRTtnQkFDNUMsU0FBUyxFQUFFLEtBQUs7YUFDakIsQ0FBQyxDQUFDO1NBQ0o7YUFBSTtZQUNILEdBQUcsR0FBRyxJQUFJLEdBQUcsQ0FBQyxHQUFHLENBQUMsSUFBSSxFQUFFLE9BQU8sRUFBRSxFQUFFLE1BQU0sRUFBRSxDQUFDLEVBQUUsQ0FBQyxDQUFDO1NBQ2pEO1FBR0QsSUFBSSxRQUFRLEdBQUcsU0FBUyxDQUFDO1FBQ3pCLElBQUksS0FBSyxDQUFDLGlCQUFpQixLQUFLLFNBQVMsRUFBQztZQUN4QyxRQUFRLEdBQUcsY0FBSSxDQUFDLFlBQVksQ0FBQyxJQUFJLEVBQUUsR0FBRyxLQUFLLENBQUMsV0FBVyxnQkFBZ0IsRUFBRSxLQUFLLENBQUMsaUJBQWlCLENBQUMsQ0FB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SyxDQUFDLElBQUk7cUJBQzFCLENBQUMsQ0FBQzthQUNKLENBQUMsQ0FBQztTQUNKO0lBRUgsQ0FBQztDQUNGO0FBRUQsTUFBTSxHQUFHLEdBQUcsSUFBSSxHQUFHLENBQUMsR0FBRyxFQUFFLENBQUM7QUFDMUIsSUFBSSxXQUFXLEdBQUcsS0FBSyxDQUFDO0FBQ3hCLElBQUksc0NBQXNDLENBQUMsR0FBRyxFQUFFLDBDQUEwQyxXQUFXLEVBQUUsRUFBRTtJQUN2RyxXQUFXLEVBQUUsV0FBVztJQUN4QixPQUFPLEVBQUUsb0VBQW9FO0lBQzdFLEdBQUcsRUFBRSxRQUFRO0lBQ2IsZUFBZSxFQUFFLElBQUk7SUFDckIsWUFBWSxFQUFFLEdBQUc7SUFDakIsWUFBWSxFQUFFLENBQUM7SUFDZixLQUFLLEVBQUUsS0FBSztJQUNaLGNBQWMsRUFBRSxJQUFJO0lBQ3BCLE9BQU8sRUFBRSxLQUFLO0lBQ2QsZUFBZSxFQUFFLEdBQUc7SUFDcEIsbUJBQW1CLEVBQUU7UUFDbkIsZUFBZSxFQUFHLG9CQUFvQjtLQUN2QztJQUNELElBQUksRUFBRSxFQUFFO0NBQ1QsQ0FBQyxDQUFDO0FBRUgsR0FBRyxDQUFDLEtBQUssRUFBRSxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IGVjMiA9IHJlcXVpcmUoJ2F3cy1jZGstbGliL2F3cy1lYzInKTtcbmltcG9ydCBlY3MgPSByZXF1aXJlKCdhd3MtY2RrLWxpYi9hd3MtZWNzJyk7XG5pbXBvcnQgY2RrID0gcmVxdWlyZSgnYXdzLWNkay1saWInKTtcbmltcG9ydCB7IExvZ0dyb3VwLCBSZXRlbnRpb25EYXlzIH0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWxvZ3MnO1xuaW1wb3J0IHsgQXdzTG9nRHJpdmVyTW9kZSwgUHJvdG9jb2wgfSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWNzJztcbmltcG9ydCB7IFNpemUsIFN0YWNrUHJvcHMgfSBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgeyBBcHBsaWNhdGlvbkxvYWRCYWxhbmNlciwgQXBwbGljYXRpb25Qcm90b2NvbCB9IGZyb20gJ2F3cy1jZGstbGliL2F3cy1lbGFzdGljbG9hZGJhbGFuY2luZ3YyJztcbmltcG9ydCB7IEZhbGxiYWNrUG9saWN5IH0gZnJvbSAnQHdoZWF0c3RhbGsvZmFyZ2F0ZS1zcG90LWZhbGxiYWNrJztcbmltcG9ydCB7IFJlcG9zaXRvcnkgfSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWNyJztcbmltcG9ydCB7IE1hbmFnZWRQb2xpY3ksIFBvbGljeSwgUG9saWN5U3RhdGVtZW50LCBSb2xlLCBTZXJ2aWNlUHJpbmNpcGFsIH0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWlhbSc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgUjdxQWR2YW5jZWRTZXJ2ZXJsZXNzTWljcm9zZXJ2aWNlU3RhY2tQcm9wcyBleHRlbmRzIFN0YWNrUHJvcHMge1xuICBzZXJ2aWNlTmFtZTogc3RyaW5nO1xuICBtZW1vcnlQZXJTZXJ2ZXI6IG51bWJlcjtcbiAgZWNyUmVwbzogc3RyaW5nO1xuICB0YWc6IHN0cmluZztcbiAgY3B1UGVyU2VydmVyOiBudW1iZXI7XG4gIGRlc2lyZWRDb3VudDogbnVtYmVyO1xuICBpc1g4NjogYm9vbGVhbjtcbiAgdXNlU3BvdDogYm9vbGVhbjtcbiAgaW50ZXJuZXRGYWNpbmc6IGJvb2xlYW47XG4gIHZwY05hbWU/OiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIGVudmlyb21lbnRWYXJpYWJsZXM6IHtcbiAgICAgIFtrZXk6IHN0cmluZ106IHN0cmluZztcbiAgfSB8IHVuZGVmaW5lZDtcbiAgcG9ydDogbnVtYmVyO1xuICBoZWFsdGhDaGVja1BhdGg6IHN0cmluZztcbiAgZXhlY3V0aW9uUm9sZU5hbWU/OiBzdHJpbmcgfCB1bmRlZmluZWQ7XG5cbn1cblxuY2xhc3MgUjdxQWR2YW5jZWRTZXJ2ZXJsZXNzTWljcm9zZXJ2aWNlU3RhY2sgZXh0ZW5kcyBjZGsuU3RhY2sge1xuICBjb25zdHJ1Y3RvcihzY29wZTogY2RrLkFwcCwgaWQ6IHN0cmluZywgcHJvcHM6IFI3cUFkdmFuY2VkU2VydmVybGVzc01pY3Jvc2VydmljZVN0YWNrUHJvcHMpIHtcbiAgICBpZighcHJvcHMuaXNYODYpe1xuICAgICAgcHJvcHMudXNlU3BvdCA9IGZhbHNlO1xuICAgIH1cblxuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuICAgIGxldCB2cGMgPSB1bmRlZmluZWQ7XG4gICAgaWYgKHByb3BzLnZwY05hbWUgIT09IHVuZGVmaW5lZCl7XG4gICAgICB2cGMgPSBlYzIuVnBjLmZyb21Mb29rdXAodGhpcywgcHJvcHMudnBjTmFtZSwge1xuICAgICAgICBpc0RlZmF1bHQ6IGZhbHNlLFxuICAgICAgfSk7XG4gICAgfWVsc2V7XG4gICAgICB2cGMgPSBuZXcgZWMyLlZwYyh0aGlzLCAnTXlWcGMnLCB7IG1heEF6czogMiB9KTtcbiAgICB9XG5cblxuICAgIGxldCB0YXNrUm9sZSA9IHVuZGVmaW5lZDtcbiAgICBpZiggcHJvcHMuZXhlY3V0aW9uUm9sZU5hbWUgIT09IHVuZGVmaW5lZCl7XG4gICAgICB0YXNrUm9sZSA9IFJvbGUuZnJvbVJvbGVOYW1lKHRoaXMsIGAke3Byb3BzLnNlcnZpY2VOYW1lfS1leGVjdXRpb25Sb2xlYCwgcHJvcHMuZXhlY3V0aW9uUm9sZU5hbWUpO1xuICAgICAgdGFza1JvbGUuYWRkTWFuYWdlZFBvbGljeShNYW5hZ2VkUG9saWN5LmZyb21Bd3NNYW5hZ2VkUG9saWN5TmFtZShcIkFXU1hSYXlEYWVtb25Xcml0ZUFjY2Vzc1wiKSlcbiAgICB9ZWxzZXtcbiAgICAgIHRhc2tSb2xlID0gbmV3IFJvbGUodGhpcywgYCR7cHJvcHMuc2VydmljZU5hbWV9LWV4ZWN1dGlvblJvbGVgLHtcbiAgICAgICAgYXNzdW1lZEJ5OiBuZXcgU2VydmljZVByaW5jaXBhbChcImVjcy10YXNrcy5hbWF6b25hd3MuY29tXCIpXG4gICAgICB9KTtcbiAgICAgIHRhc2tSb2xlLmFkZE1hbmFnZWRQb2xpY3koTWFuYWdlZFBvbGljeS5mcm9tQXdzTWFuYWdlZFBvbGljeU5hbWUoXCJBV1NYUmF5RGFlbW9uV3JpdGVBY2Nlc3NcIikpXG4gICAgICBjb25zdCBwZXJtaXNzaW9ucyA9IG5ldyBQb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgJ3NzbW1lc3NhZ2VzOionLFxuICAgICAgICAgICdkeW5hbW9kYjoqJyxcbiAgICAgICAgICAncmRzOionLFxuICAgICAgICAgICdjbG91ZHdhdGNoOionLFxuICAgICAgICBdLFxuICAgICAgICByZXNvdXJjZXM6IFtcbiAgICAgICAgICBgKmBcbiAgICAgICAgXSxcbiAgICAgIH0pO1xuICAgICAgbGV0IHBvbGljeSA9IG5ldyBQb2xpY3kodGhpcywgYCR7cHJvcHMuc2VydmljZU5hbWV9LUV4ZWN1dGlvblJvbGVQb2xpY3lgLCB7XG4gICAgICAgIHN0YXRlbWVudHM6IFtcbiAgICAgICAgICBwZXJtaXNzaW9uc1xuICAgICAgICBdXG4gICAgICB9KTtcbiAgICAgIHRhc2tSb2xlLmFkZE1hbmFnZWRQb2xpY3koTWFuYWdlZFBvbGljeS5mcm9tQXdzTWFuYWdlZFBvbGljeU5hbWUoXCJBbWF6b25EeW5hbW9EQkZ1bGxBY2Nlc3NcIikpXG4gICAgICB0YXNrUm9sZS5hdHRhY2hJbmxpbmVQb2xpY3kocG9saWN5KTtcbiAgICB9XG4gICAgXG4gICAgY29uc3QgY2x1c3RlciA9IG5ldyBlY3MuQ2x1c3Rlcih0aGlzLCBgJHtwcm9wcy5zZXJ2aWNlTmFtZX0tRmFyZ2F0ZUNsdXN0ZXJgLCB7IFxuICAgICAgdnBjLFxuICAgICAgY2x1c3Rlck5hbWU6IGAke3Byb3BzLnNlcnZpY2VOYW1lfS1GYXJnYXRlQ2x1c3RlcmAsXG4gICAgICBlbmFibGVGYXJnYXRlQ2FwYWNpdHlQcm92aWRlcnM6IHRydWUsXG4gICAgICBjb250YWluZXJJbnNpZ2h0czogdHJ1ZVxuICAgIH0pO1xuICAgIGNvbnN0IGxvZ0dyb3VwQXBwbGljYXRpb24gPSBuZXcgTG9nR3JvdXAodGhpcywgYCR7cHJvcHMuc2VydmljZU5hbWV9LWFwcGxpY2F0aW9uLWxvZ3NgLCB7XG4gICAgICByZXRlbnRpb246IFJldGVudGlvbkRheXMuU0lYX01PTlRIUyxcbiAgICB9KTtcblxuICAgIGNvbnN0IGxvZ0dyb3VwWHJheSA9IG5ldyBMb2dHcm91cCh0aGlzLCBgJHtwcm9wcy5zZXJ2aWNlTmFtZX0teC1yYXktbG9nc2AsIHtcbiAgICAgIHJldGVudGlvbjogUmV0ZW50aW9uRGF5cy5TSVhfTU9OVEhTLFxuICAgIH0pO1xuICAgIC8vIGNyZWF0ZSBhIHRhc2sgZGVmaW5pdGlvbiB3aXRoIENsb3VkV2F0Y2ggTG9nc1xuICAgIGNvbnN0IGxvZ2dpbmcgPSBuZXcgZWNzLkF3c0xvZ0RyaXZlcih7XG4gICAgICBzdHJlYW1QcmVmaXg6IGAke3Byb3BzLnNlcnZpY2VOYW1lfWAsXG4gICAgICBsb2dHcm91cDogbG9nR3JvdXBBcHBsaWNhdGlvbixcbiAgICAgIG1heEJ1ZmZlclNpemU6IFNpemUubWViaWJ5dGVzKDMpLFxuICAgICAgbW9kZTogQXdzTG9nRHJpdmVyTW9kZS5OT05fQkxPQ0tJTkdcbiAgICB9KTtcblxuICAgIGNvbnN0IHhyYXlMb2dnaW5nID0gbmV3IGVjcy5Bd3NMb2dEcml2ZXIoe1xuICAgICAgc3RyZWFtUHJlZml4OiBgJHtwcm9wcy5zZXJ2aWNlTmFtZX1gLFxuICAgICAgbG9nR3JvdXA6IGxvZ0dyb3VwWHJheSxcbiAgICAgIG1heEJ1ZmZlclNpemU6IFNpemUubWViaWJ5dGVzKDMpLFxuICAgICAgbW9kZTogQXdzTG9nRHJpdmVyTW9kZS5OT05fQkxPQ0tJTkdcbiAgICB9KTtcblxuXG4gICAgY29uc3QgdGFza0RlZiA9IG5ldyBlY3MuRmFyZ2F0ZVRhc2tEZWZpbml0aW9uKHRoaXMsIGAke3Byb3BzLnNlcnZpY2VOYW1lfS1UYXNrRGVmaW5pdGlvbmAsIHtcbiAgICAgIG1lbW9yeUxpbWl0TWlCOiBwcm9wcy5tZW1vcnlQZXJTZXJ2ZXIsXG4gICAgICBjcHU6IHByb3BzLmNwdVBlclNlcnZlcixcbiAgICAgIGV4ZWN1dGlvblJvbGU6IHRhc2tSb2xlLFxuICAgICAgdGFza1JvbGU6IHRhc2tSb2xlLFxuICAgICAgcnVudGltZVBsYXRmb3JtOiB7XG4gICAgICAgIG9wZXJhdGluZ1N5c3RlbUZhbWlseTogZWNzLk9wZXJhdGluZ1N5c3RlbUZhbWlseS5MSU5VWCxcbiAgICAgICAgY3B1QXJjaGl0ZWN0dXJlOiBwcm9wcy5pc1g4Nj8gZWNzLkNwdUFyY2hpdGVjdHVyZS5YODZfNjQ6IGVjcy5DcHVBcmNoaXRlY3R1cmUuQVJNNjRcbiAgICAgIH1cbiAgICB9KVxuICAgIFxuICAgIHRhc2tEZWYuYWRkQ29udGFpbmVyKCd4cmF5Jywge1xuICAgICAgaW1hZ2U6IGVjcy5Db250YWluZXJJbWFnZS5mcm9tUmVnaXN0cnkoJ2FtYXpvbi9hd3MteHJheS1kYWVtb24nKSxcbiAgICAgIHBvcnRNYXBwaW5ncyA6IFtcbiAgICAgICAge1xuICAgICAgICAgICAgXCJjb250YWluZXJQb3J0XCI6IDIwMDAsXG4gICAgICAgICAgICBcInByb3RvY29sXCI6IFByb3RvY29sLlVEUFxuICAgICAgICB9XG4gICAgIF0sXG4gICAgIGNwdTogMzIsXG4gICAgIG1lbW9yeVJlc2VydmF0aW9uTWlCOiAxMjgsXG4gICAgIGVzc2VudGlhbDogZmFsc2UsXG4gICAgIGxvZ2dpbmc6IHhyYXlMb2dnaW5nXG4gICAgfSk7XG5cbiAgICAvLyBsZXQgaGVhbHRoQ2hlY2tVcmwgPSBgaHR0cDovL2xvY2FsaG9zdDoke3Byb3BzLnBvcnR9JHtwcm9wcy5oZWFsdGhDaGVja1BhdGh9YDtcbiAgICBsZXQgaGVhbHRoQ2hlY2tVcmwgPSBgaHR0cDovL2xvY2FsaG9zdC9gXG5cbiAgICB0YXNrRGVmLmFkZENvbnRhaW5lcihgJHtwcm9wcy5zZXJ2aWNlTmFtZX0tYXBwbGljYXRpb25gLCB7XG4gICAgICBpbWFnZTogZWNzLkNvbnRhaW5lckltYWdlLmZyb21FY3JSZXBvc2l0b3J5KFxuICAgICAgICBSZXBvc2l0b3J5LmZyb21SZXBvc2l0b3J5QXJuKHRoaXMsIGAke3Byb3BzLnNlcnZpY2VOYW1lfS1yZXBvc2l0b3J5YCwgXG4gICAgICBwcm9wcy5lY3JSZXBvKSwgcHJvcHMudGFnXG4gICAgICApLFxuICAgICAgY29udGFpbmVyTmFtZTogYCR7cHJvcHMuc2VydmljZU5hbWV9LWFwcGxpY2F0aW9uYCwgICBcbiAgICAgIGxvZ2dpbmc6IGxvZ2dpbmcsXG4gICAgICBlc3NlbnRpYWw6IHRydWUsXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICAuLi5wcm9wcy5lbnZpcm9tZW50VmFyaWFibGVzXG4gICAgICB9LFxuICAgICAgcG9ydE1hcHBpbmdzIDogW1xuICAgICAgICB7XG4gICAgICAgICAgICBcImNvbnRhaW5lclBvcnRcIjogcHJvcHMucG9ydCxcbiAgICAgICAgICAgIFwicHJvdG9jb2xcIjogUHJvdG9jb2wuVENQXG4gICAgICAgIH1cbiAgICAgXSxcbiAgICAgaGVhbHRoQ2hlY2s6IHtcbiAgICAgIGNvbW1hbmQ6IFsgXCJDTUQtU0hFTExcIixgY3VybCAtZiAke2hlYWx0aENoZWNrVXJsfSB8fCBleGl0IDFgXVxuICAgICB9XG4gICAgfSk7XG4gICAgXG4gICAgY29uc3QgbGIgPSBuZXcgQXBwbGljYXRpb25Mb2FkQmFsYW5jZXIodGhpcywgYCR7cHJvcHMuc2VydmljZU5hbWV9LUFsYmAsIHtcbiAgICAgIHZwYyxcbiAgICAgIGxvYWRCYWxhbmNlck5hbWU6IGAke3Byb3BzLnNlcnZpY2VOYW1lfWAsXG4gICAgICBpbnRlcm5ldEZhY2luZzogcHJvcHMuaW50ZXJuZXRGYWNpbmcsXG4gICAgfSk7XG4gICAgbGIuc2V0QXR0cmlidXRlKCdyb3V0aW5nLmh0dHAuZGVzeW5jX21pdGlnYXRpb25fbW9kZScsICdzdHJpY3Rlc3QnKTtcbiAgICBsYi5zZXRBdHRyaWJ1dGUoJ3JvdXRpbmcuaHR0cC5kcm9wX2ludmFsaWRfaGVhZGVyX2ZpZWxkcy5lbmFibGVkJywgJ3RydWUnKTtcbiAgICBsYi5zZXRBdHRyaWJ1dGUoJ3JvdXRpbmcuaHR0cC5wcmVzZXJ2ZV9ob3N0X2hlYWRlci5lbmFibGVkJywgJ3RydWUnKTtcbiAgICBsZXQgbGlzdGVuZXIgPSBsYi5hZGRMaXN0ZW5lcihgJHtwcm9wcy5zZXJ2aWNlTmFtZX0tbGlzdGVuZXJgLCB7XG4gICAgICBwcm90b2NvbDogQXBwbGljYXRpb25Qcm90b2NvbC5IVFRQLFxuICAgICAgcG9ydDogODBcbiAgICB9KTtcbiAgICBsZXQgc2VjdXJpdHkgPSBuZXcgZWMyLlNlY3VyaXR5R3JvdXAodGhpcywgYCR7cHJvcHMuc2VydmljZU5hbWV9LXNlY3VyaXR5LWdyb3VwYCwge1xuICAgICAgZGVzY3JpcHRpb246IGBTZWN1cml0eSBncm91cCB0aGF0IGRlZmluZXMgcG9ydCBpbmdyZXNzL2VncmVzcyBmb3IgdGhlICR7cHJvcHMuc2VydmljZU5hbWV9IGJhY2tlbmRgLFxuICAgICAgdnBjOiB2cGMsXG4gICAgICBhbGxvd0FsbE91dGJvdW5kOiB0cnVlLFxuICAgICAgYWxsb3dBbGxJcHY2T3V0Ym91bmQ6IHRydWVcbiAgICB9KTtcbiAgICBzZWN1cml0eS5hZGRJbmdyZXNzUnVsZShlYzIuUGVlci5hbnlJcHY0KCksIGVjMi5Qb3J0LnRjcChwcm9wcy5wb3J0KSk7XG4gICAgc2VjdXJpdHkuYWRkSW5ncmVzc1J1bGUoZWMyLlBlZXIuYW55SXB2NCgpLCBlYzIuUG9ydC5pY21wUGluZygpKTtcblxuICAgIGxldCBzZWN1cml0eUdyb3VwcyA9IFtzZWN1cml0eV07XG4gICAgXG5cbiAgICAvLyBDcmVhdGUgYSBmYWxsYmFjayBzZXJ2aWNlIHdpdGggb24tZGVtYW5kIEZhcmdhdGUgYW5kIGEgZGVzaXJlZCBjb3VudCBvZlxuICAgIC8vIHplcm8uIFRoaXMgc2VydmljZSBzaG91bGQgYmUgdGhlIHNhbWUgYXMgeW91ciBwcmltYXJ5IHNlcnZpY2UsIGV4Y2VwdFxuICAgIC8vIHdpdGggYSBkaWZmZXJlbnQgY2FwYWNpdHkgcHJvdmlkZXIgYW5kIGFuIGluaXRpYWwgZGVzaXJlZCBjb3VudCBvZiB6ZXJvLlxuICAgIGxldCBmYXJnYXRlU2VydmljZSA9IG5ldyBlY3MuRmFyZ2F0ZVNlcnZpY2UodGhpcywgYCR7cHJvcHMuc2VydmljZU5hbWV9LUZhcmdhdGVTZXJ2aWNlYCwge1xuICAgICAgY2x1c3RlcixcbiAgICAgIHRhc2tEZWZpbml0aW9uOnRhc2tEZWYsXG4gICAgICBwbGF0Zm9ybVZlcnNpb246IGVjcy5GYXJnYXRlUGxhdGZvcm1WZXJzaW9uLlZFUlNJT04xXzQsXG4gICAgICBjYXBhY2l0eVByb3ZpZGVyU3RyYXRlZ2llczogW3sgY2FwYWNpdHlQcm92aWRlcjogJ0ZBUkdBVEUnLCB3ZWlnaHQ6IDEgfV0sXG4gICAgfSk7XG5cbiAgICBjb25zdCBzY2FsYWJsZVRhcmdldCA9IGZhcmdhdGVTZXJ2aWNlLmF1dG9TY2FsZVRhc2tDb3VudCh7XG4gICAgICBtaW5DYXBhY2l0eTogMSxcbiAgICAgIG1heENhcGFjaXR5OiAzLFxuICAgIH0pO1xuICAgIFxuICAgIHNjYWxhYmxlVGFyZ2V0LnNjYWxlT25DcHVVdGlsaXphdGlvbihgJHtwcm9wcy5zZXJ2aWNlTmFtZX0tQ3B1U2NhbGluZ2AsIHtcbiAgICAgIHRhcmdldFV0aWxpemF0aW9uUGVyY2VudDogOTAsXG4gICAgfSk7XG5cbiAgICBzY2FsYWJsZVRhcmdldC5zY2FsZU9uTWVtb3J5VXRpbGl6YXRpb24oYCR7cHJvcHMuc2VydmljZU5hbWV9LU1lbW9yeVNjYWxpbmdgLCB7XG4gICAgICB0YXJnZXRVdGlsaXphdGlvblBlcmNlbnQ6IDkwLFxuICAgIH0pO1xuXG4gICAgaWYocHJvcHMudXNlU3BvdCAmJiBwcm9wcy5pc1g4Nil7XG4gICAgICBsZXQgZmdTcG90U2VydmljZSA9IG5ldyBlY3MuRmFyZ2F0ZVNlcnZpY2UodGhpcywgYCR7cHJvcHMuc2VydmljZU5hbWV9LUZhcmdhdGVTcG90U2VydmljZWAsIHtcbiAgICAgICAgY2x1c3RlcixcbiAgICAgICAgdGFza0RlZmluaXRpb246dGFza0RlZixcbiAgICAgICAgc2VjdXJpdHlHcm91cHM6IHNlY3VyaXR5R3JvdXBzLFxuICAgICAgICBwbGF0Zm9ybVZlcnNpb246IGVjcy5GYXJnYXRlUGxhdGZvcm1WZXJzaW9uLlZFUlNJT04xXzQsXG4gICAgICAgIGNhcGFjaXR5UHJvdmlkZXJTdHJhdGVnaWVzOiBbeyBjYXBhY2l0eVByb3ZpZGVyOiAnRkFSR0FURV9TUE9UJywgd2VpZ2h0OiAxIH1dLFxuICAgICAgICBkZXNpcmVkQ291bnQ6IDEsXG4gICAgICB9KTtcbiAgICAgIGxpc3RlbmVyLmFkZFRhcmdldHMoYCR7cHJvcHMuc2VydmljZU5hbWV9LUZhcmdhdGVUYXJnZXRgLCB7XG4gICAgICAgIHBvcnQ6IHByb3BzLnBvcnQsXG4gICAgICAgIHRhcmdldHM6IFtmZ1Nwb3RTZXJ2aWNlLmxvYWRCYWxhbmNlclRhcmdldCh7XG4gICAgICAgICAgY29udGFpbmVyTmFtZTogYCR7cHJvcHMuc2VydmljZU5hbWV9LWFwcGxpY2F0aW9uYCxcbiAgICAgICAgICBjb250YWluZXJQb3J0OiBwcm9wcy5wb3J0LFxuICAgICAgICB9KSwgZmFyZ2F0ZVNlcnZpY2UhLmxvYWRCYWxhbmNlclRhcmdldCh7XG4gICAgICAgICAgY29udGFpbmVyTmFtZTogYCR7cHJvcHMuc2VydmljZU5hbWV9LWFwcGxpY2F0aW9uYCxcbiAgICAgICAgICBjb250YWluZXJQb3J0OiBwcm9wcy5wb3J0LFxuICAgICAgICB9KV1cbiAgICAgIH0pO1xuICAgICAgLy8gQ3JlYXRlIHRoZSBmYWxsYmFjayBwb2xpY3kgd2hpY2ggaW5jcmVhc2VzIHRoZSBmYWxsYmFjayBzZXJ2aWNlJ3MgZGVzaXJlZFxuICAgICAgLy8gY291bnQgd2hlbiB0aGUgcHJpbWFyeSBzZXJ2aWNlIGNhbid0IHByb3Zpc2lvbiB0YXNrcy5cbiAgICAgIG5ldyBGYWxsYmFja1BvbGljeSh0aGlzLCBgJHtwcm9wcy5zZXJ2aWNlTmFtZX0tRmFsbGJhY2tQb2xpY3ktRG8tbm90LWRlbGV0ZWAsIHtcbiAgICAgICAgcHJpbWFyeVNlcnZpY2U6ZmFyZ2F0ZVNlcnZpY2UsXG4gICAgICAgIGZhbGxiYWNrU2VydmljZTogZmdTcG90U2VydmljZSxcbiAgICAgIH0pO1xuICAgIH1lbHNle1xuICAgICAgbGlzdGVuZXIuYWRkVGFyZ2V0cyhgJHtwcm9wcy5zZXJ2aWNlTmFtZX0tRmFyZ2F0ZVRhcmdldGAsIHtcbiAgICAgICAgcG9ydDogcHJvcHMucG9ydCxcbiAgICAgICAgdGFyZ2V0czogW2ZhcmdhdGVTZXJ2aWNlLmxvYWRCYWxhbmNlclRhcmdldCh7XG4gICAgICAgICAgY29udGFpbmVyTmFtZTogYCR7cHJvcHMuc2VydmljZU5hbWV9LWFwcGxpY2F0aW9uYCxcbiAgICAgICAgICBjb250YWluZXJQb3J0OiBwcm9wcy5wb3J0LFxuICAgICAgICB9KV1cbiAgICAgIH0pO1xuICAgIH1cbiAgICBcbiAgfVxufVxuXG5jb25zdCBhcHAgPSBuZXcgY2RrLkFwcCgpO1xubGV0IHNlcnZpY2VOYW1lID0gXCJyN3FcIjtcbm5ldyBSN3FBZHZhbmNlZFNlcnZlcmxlc3NNaWNyb3NlcnZpY2VTdGFjayhhcHAsIGBSN3FBZHZhbmNlZFNlcnZlcmxlc3NNaWNyb3NlcnZpY2VTdGFjay0ke3NlcnZpY2VOYW1lfWAsIHtcbiAgc2VydmljZU5hbWU6IHNlcnZpY2VOYW1lLFxuICBlY3JSZXBvOiBcImFybjphd3M6ZWNyOnVzLWVhc3QtMToxNTQ3MDE3Mzg3NzM6cmVwb3NpdG9yeS9ub3ZhY2xvdWQtcmVwb3NpdG9yeVwiLFxuICB0YWc6IFwibGF0ZXN0XCIsXG4gIG1lbW9yeVBlclNlcnZlcjogMTAyNCxcbiAgY3B1UGVyU2VydmVyOiA1MTIsXG4gIGRlc2lyZWRDb3VudDogMSxcbiAgaXNYODY6IGZhbHNlLFxuICBpbnRlcm5ldEZhY2luZzogdHJ1ZSxcbiAgdXNlU3BvdDogZmFsc2UsXG4gIGhlYWx0aENoZWNrUGF0aDogXCIvXCIsXG4gIGVudmlyb21lbnRWYXJpYWJsZXM6IHtcbiAgICBcIkRBVEFCQVNFX05BTUVcIiA6IGBkeW5hbW9kYnRpbWVzZXJpZXNgLFxuICB9LFxuICBwb3J0OiA4MFxufSk7XG5cbmFwcC5zeW50aCgpO1xuIl19